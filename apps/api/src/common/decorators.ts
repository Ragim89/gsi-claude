import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser, Permission, Role } from '@gsi/shared-types';

export const IS_PUBLIC = 'gsi:isPublic';
export const ROLES = 'gsi:roles';
export const PERMISSIONS = 'gsi:permissions';

/** Skips authentication for a route (login, refresh, health, public report verification). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Restricts a route to holders of a permission — the way access is expressed from Phase 1 on.
 * Several permissions mean "any of them is enough".
 */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS, permissions);

/**
 * Restricts a route to the given roles.
 *
 * @deprecated Roles describe who someone is, not what they may do. Use RequirePermission:
 * a new role then needs no code change at all. Kept for routes not yet converted.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
