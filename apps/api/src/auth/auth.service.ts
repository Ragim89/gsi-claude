import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { AuthTokens, AuthUser, Role } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { config } from '../config';
import type { AccessTokenPayload } from '../common/auth.guard';

interface UserRow {
  id: string;
  branch_id: string;
  role: Role;
  email: string;
  password_hash: string;
  full_name: string;
  locale: string;
  is_active: boolean;
}

// Compared against for unknown emails so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

/**
 * JWT access (short-lived) + refresh (long-lived) tokens — docs/05-tech-stack.md.
 * ASSUMPTION: refresh tokens are stateless for MVP-1 (no server-side revocation list);
 * deactivating a user takes effect at the next refresh (≤ access TTL, 15 min by default).
 * Mandatory 2FA for finance roles is planned together with the finance module (MVP-2/3).
 */
@Injectable()
export class AuthService {
  constructor(private readonly db: DbService, private readonly jwt: JwtService) {}

  async login(email: string, password: string): Promise<AuthTokens> {
    const row = await this.findUser(email, null);
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || !row.is_active) throw new UnauthorizedException('Invalid email or password');
    return this.issue(row);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let sub: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(refreshToken, {
        secret: config.jwt.refreshSecret,
      });
      if (payload.typ !== 'refresh') throw new Error('wrong type');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const row = await this.findUser(null, sub);
    if (!row || !row.is_active) throw new UnauthorizedException('User is inactive');
    return this.issue(row);
  }

  private findUser(email: string | null, id: string | null): Promise<UserRow | null> {
    // auth_find_user is SECURITY DEFINER: login happens before any branch context exists.
    return this.db.tx(null, (tx) => tx.one<UserRow>('SELECT * FROM auth_find_user($1, $2)', [email, id]));
  }

  private async issue(row: UserRow): Promise<AuthTokens> {
    const user: AuthUser = {
      id: row.id,
      branchId: row.branch_id,
      role: row.role,
      email: row.email,
      fullName: row.full_name,
      locale: row.locale,
    };
    const access: AccessTokenPayload = {
      sub: user.id,
      branchId: user.branchId,
      role: user.role,
      email: user.email,
      name: user.fullName,
      locale: user.locale,
      typ: 'access',
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(access, { secret: config.jwt.accessSecret, expiresIn: config.jwt.accessTtlSeconds }),
      this.jwt.signAsync({ sub: user.id, typ: 'refresh' }, { secret: config.jwt.refreshSecret, expiresIn: config.jwt.refreshTtlSeconds }),
    ]);
    return { accessToken, refreshToken, user };
  }
}
