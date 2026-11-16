// The one permission map (CLAUDE.md → Tenancy and security). Every route names a permission with @Can, or is
// explicitly @Public; a route with neither is refused (default deny, enforced in auth.guard.ts).
import { SetMetadata } from '@nestjs/common';
import { ROLES } from '@app/contracts';

type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'me.read': ROLES,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const permissionsOf = (role: Role): Permission[] =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => (PERMISSIONS[p] as readonly Role[]).includes(role));

export const CAN = 'permission';
export const PUBLIC = 'public';
export const Can = (permission: Permission) => SetMetadata(CAN, permission);
export const Public = () => SetMetadata(PUBLIC, true);
