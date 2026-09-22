import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser, Role } from '@gsi/shared-types';
import { config } from '../config';
import { IS_PUBLIC, ROLES } from './decorators';

export interface AccessTokenPayload {
  sub: string;
  branchId: string;
  role: Role;
  email: string;
  name: string;
  locale: string;
  typ: 'access';
}

/**
 * Global guard: verifies the bearer access token and enforces @Roles().
 * Branch isolation itself is enforced by PostgreSQL RLS (see DbService.tx), not here.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

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

    const user: AuthUser = {
      id: payload.sub,
      branchId: payload.branchId,
      role: payload.role,
      email: payload.email,
      fullName: payload.name,
      locale: payload.locale,
    };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
