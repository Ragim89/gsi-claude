import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AccessScope, AuthUser, Permission, Role } from '@gsi/shared-types';
import { config } from '../config';
import { RbacService } from '../auth/rbac.service';
import { IS_PUBLIC, PERMISSIONS, ROLES } from './decorators';

export interface AccessTokenPayload {
  sub: string;
  branchId: string;
  countryId?: string | null;
  role: Role;
  email: string;
  name: string;
  locale: string;
  /** Role codes; the permissions behind them are resolved server-side and cached. */
  roles?: string[];
  typ: 'access';
}

/**
 * Global guard: verifies the bearer token, resolves what the caller may do, and enforces
 * `@RequirePermission()` (and the older `@Roles()`).
 *
 * Which ROWS the caller may touch is not decided here — that is PostgreSQL's job, through the
 * access context this guard prepares (see DbService.tx).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, { secret: config.jwt.accessSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException('Wrong token type');

    // A token issued before roles existed still names a role: treat it as that one role.
    // The current assignment is read from the database (cached for a few seconds), so roles
    // granted or revoked take effect without waiting for the token to expire.
    const roles = await this.rbac.rolesFor(payload.sub, payload.roles?.length ? payload.roles : [payload.role]);
    const [permissions, scope] = await Promise.all([
      this.rbac.permissionsFor(roles),
      this.rbac.scopeFor(roles),
    ]);

    const user: AuthUser = {
      id: payload.sub,
      branchId: payload.branchId,
      countryId: payload.countryId ?? null,
      role: payload.role,
      email: payload.email,
      fullName: payload.name,
      locale: payload.locale,
      roles,
      scope: scope as AccessScope,
      permissions,
    };
    req.user = user;

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS, targets);
    if (required?.length && !required.some((p) => permissions.includes(p))) {
      throw new ForbiddenException(`Requires permission: ${required.join(' or ')}`);
    }

    const allowedRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (allowedRoles?.length && !allowedRoles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
