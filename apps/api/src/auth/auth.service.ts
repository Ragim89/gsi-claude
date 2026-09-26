import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import type { AccessScope, AuthTokens, AuthUser, Permission, Role } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { config } from '../config';
import type { AccessTokenPayload } from '../common/auth.guard';
import { AuditContext, AuditService } from '../common/audit.service';

interface UserRow {
  id: string;
  branch_id: string;
  country_id: string | null;
  role: Role;
  email: string;
  password_hash: string;
  full_name: string;
  locale: string;
  is_active: boolean;
  roles: string[];
  scope: AccessScope;
  permissions: Permission[];
}

/** What the controller needs to set the refresh cookie; the raw value never leaves this module otherwise. */
export interface IssuedSession extends AuthTokens {
  refreshToken: string;
  refreshTtlSeconds: number;
}

// Compared against for unknown emails so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

function newRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * JWT access token (short-lived, stateless) + opaque refresh token (long-lived, registered
 * in `refresh_tokens` — PHASE 12). The refresh token itself is never held in JS: it travels
 * only as an httpOnly cookie, and only its SHA-256 is ever written to the database.
 *
 * Mandatory 2FA for finance roles is planned together with the finance module (MVP-2/3).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, ctx: AuditContext = {}): Promise<IssuedSession> {
    const row = await this.findUser(email, null);
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || !row.is_active) {
      // Failed attempts are recorded too: a burst of them against one account is the first
      // sign of an attack, and without a log nobody would ever see it.
      await this.audit.log(
        null,
        {
          action: 'auth.login.failed',
          entityType: 'user',
          entityLabel: email,
          branchId: row?.branch_id ?? null,
          metadata: { reason: !row ? 'unknown_email' : !ok ? 'wrong_password' : 'inactive' },
        },
        ctx,
      );
      throw new UnauthorizedException('Invalid email or password');
    }
    const session = await this.issue(row, ctx);
    await this.audit.log(session.user, { action: 'auth.login', entityType: 'user', entityId: row.id,
      entityLabel: row.email, branchId: row.branch_id }, ctx);
    return session;
  }

  /**
   * Exchanges a refresh cookie for a new one, rotating it. A token presented a second time —
   * the shape theft takes — burns every other token issued from the same login, not just this
   * one: `auth_rotate_refresh_token` does the lookup, the reuse check and the rotation as one
   * atomic step so two refreshes racing on the same token cannot both succeed.
   */
  async refresh(rawToken: string, ctx: AuditContext = {}): Promise<IssuedSession> {
    const oldHash = hashToken(rawToken);
    const newRaw = newRawToken();
    const newHash = hashToken(newRaw);
    const outcome = await this.db.tx(null, (tx) =>
      tx.one<{ user_id: string | null; new_id: string | null; reused: boolean; denied: boolean }>(
        'SELECT * FROM auth_rotate_refresh_token($1, $2, $3, $4, $5)',
        [oldHash, newHash, config.jwt.refreshTtlSeconds, ctx.ip ?? null, ctx.userAgent ?? null],
      ),
    );
    if (outcome?.reused) {
      // Not just "denied" — this is what a stolen refresh token replayed against the API
      // looks like, so it gets its own, louder, entry.
      await this.audit.log(
        null,
        {
          action: 'auth.refresh.reuse_detected',
          entityType: 'user',
          entityId: outcome.user_id,
          metadata: { note: 'entire refresh-token family revoked' },
        },
        ctx,
      );
    }
    if (!outcome || outcome.denied || !outcome.new_id) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const row = await this.findUser(null, outcome.user_id);
    if (!row || !row.is_active) throw new UnauthorizedException('User is inactive');
    const access = await this.signAccessToken(this.toAuthUser(row));
    return { accessToken: access, user: this.toAuthUser(row), refreshToken: newRaw, refreshTtlSeconds: config.jwt.refreshTtlSeconds };
  }

  /** Signs the presented refresh token out; a missing or already-invalid token is not an error. */
  async logout(rawToken: string, ctx: AuditContext = {}): Promise<void> {
    const revoked = await this.db.tx(null, (tx) =>
      tx.one<{ auth_revoke_refresh_token: boolean }>('SELECT auth_revoke_refresh_token($1)', [hashToken(rawToken)]),
    );
    if (revoked) await this.audit.log(null, { action: 'auth.logout' }, ctx);
  }

  /** Signs every device out. Used for the user's own "log out everywhere", and on deactivation. */
  async logoutAll(userId: string, reason: string, ctx: AuditContext = {}): Promise<number> {
    const result = await this.db.tx(null, (tx) =>
      tx.one<{ auth_revoke_all_refresh_tokens: number }>('SELECT auth_revoke_all_refresh_tokens($1, $2)', [
        userId,
        reason,
      ]),
    );
    const count = result?.auth_revoke_all_refresh_tokens ?? 0;
    await this.audit.log(null, {
      action: 'auth.logout_all',
      entityType: 'user',
      entityId: userId,
      metadata: { reason, sessionsRevoked: count },
    }, ctx);
    return count;
  }

  private findUser(email: string | null, id: string | null): Promise<UserRow | null> {
    // auth_find_user is SECURITY DEFINER: login happens before any branch context exists.
    // It also returns the user's roles, effective scope and permissions.
    return this.db.tx(null, (tx) => tx.one<UserRow>('SELECT * FROM auth_find_user($1, $2)', [email, id]));
  }

  private toAuthUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      branchId: row.branch_id,
      countryId: row.country_id,
      role: row.role,
      email: row.email,
      fullName: row.full_name,
      locale: row.locale,
      roles: row.roles ?? [],
      scope: row.scope,
      permissions: row.permissions ?? [],
    };
  }

  private signAccessToken(user: AuthUser): Promise<string> {
    // The token carries role codes, not permissions: it stays small, and a change to what a
    // role may do reaches everyone without forcing them to sign in again.
    const access: AccessTokenPayload = {
      sub: user.id,
      branchId: user.branchId,
      countryId: user.countryId,
      role: user.role,
      email: user.email,
      name: user.fullName,
      locale: user.locale,
      roles: user.roles,
      typ: 'access',
    };
    return this.jwt.signAsync(access, { secret: config.jwt.accessSecret, expiresIn: config.jwt.accessTtlSeconds });
  }

  private async issue(row: UserRow, ctx: AuditContext): Promise<IssuedSession> {
    const user = this.toAuthUser(row);
    const rawRefresh = newRawToken();
    const [accessToken] = await Promise.all([
      this.signAccessToken(user),
      this.db.tx(null, (tx) =>
        tx.one(
          'SELECT auth_issue_refresh_token($1, $2, $3, $4, $5)',
          [user.id, hashToken(rawRefresh), config.jwt.refreshTtlSeconds, ctx.ip ?? null, ctx.userAgent ?? null],
        ),
      ),
    ]);
    return { accessToken, user, refreshToken: rawRefresh, refreshTtlSeconds: config.jwt.refreshTtlSeconds };
  }
}
