import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser, Role } from '@gsi/shared-types';

export const IS_PUBLIC = 'gsi:isPublic';
export const ROLES = 'gsi:roles';

/** Skips authentication for a route (login, refresh, health, public report verification). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to the given roles. Without it any authenticated user passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
