import { randomUUID } from 'node:crypto';
import {
  BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException,
  type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { verifyToken } from '@clerk/backend';
import { z } from 'zod';
import type pg from 'pg';
import { resolveAccess } from '@app/db';
import { Role, TenantIdHeader } from '@app/contracts';
import { CAN, PERMISSIONS, PUBLIC, type Permission } from './permissions.js';
import { POOL } from '../db.js';

/** What a guarded handler may rely on: a verified Clerk user, the tenant they act for, and their role there. */
export type Caller = { userId: string; tenantId: string; role: z.infer<typeof Role>; requestId: string };
type Req = { headersDistinct: Record<string, string[] | undefined>; caller?: Caller };
type Res = { setHeader(name: string, value: string): void };

// Clerk session token v2 (docs: guides/sessions/session-tokens). fva[1] is minutes since the second factor, -1 if none.
const Claims = z.object({
  v: z.literal(2),
  sid: z.string().min(1),
  sub: z.string().min(1),
  sts: z.string().optional(),
  fva: z.tuple([z.number(), z.number()]).optional(),
  o: z.object({ id: z.string().min(1) }).optional(),
});

// @clerk/backend also accepts JWT-template tokens (same key, admin-defined claims and lifetime): only session tokens here.
const SESSION_TOKEN = 'cl_B7d4PD111AAA';
const Header = z.object({ cat: z.literal(SESSION_TOKEN) });
const isSessionToken = (token: string): boolean => {
  try {
    return Header.safeParse(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'))).success;
  } catch {
    return false;
  }
};

/** One value, or undefined. A repeated header is ambiguous, so it is refused (400), never merged or guessed. */
const header = (req: Req, name: string): string | undefined => {
  const v = req.headersDistinct[name];
  if (v && v.length > 1) throw new BadRequestException(`${name} was sent more than once`);
  return v?.[0];
};

/**
 * Global guard (spec → Request path): verify the Clerk JWT, resolve the tenant from X-Tenant-Id or the active org,
 * read the role from the database under RLS, require MFA for firm roles, then check the route's permission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(POOL) private readonly pool: pg.Pool) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, targets)) return true;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(CAN, targets);
    if (!permission) throw new ForbiddenException(); // a route nobody gave a permission is closed

    const req = ctx.switchToHttp().getRequest<Req>();
    const requestId = randomUUID(); // ours, never the client's: a supplied id could collide with another caller's in Sentry
    ctx.switchToHttp().getResponse<Res>().setHeader('x-request-id', requestId);
    Sentry.getIsolationScope().setTag('request_id', requestId);

    const jwtKey = process.env.CLERK_JWT_KEY;
    const issuer = process.env.CLERK_ISSUER;
    const parties = process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((p) => p.trim()).filter(Boolean);
    if (!jwtKey || !issuer || !parties?.length) throw new ServiceUnavailableException(); // fail closed, and say nothing about our configuration

    const token = /^Bearer ([^\s]+)$/.exec(header(req, 'authorization') ?? '')?.[1];
    if (!token || !isSessionToken(token)) throw new UnauthorizedException();
    let claims: z.infer<typeof Claims>;
    try {
      claims = Claims.parse(await verifyToken(token, { jwtKey, issuer, authorizedParties: parties }));
    } catch {
      throw new UnauthorizedException();
    }
    if (claims.sts === 'pending') throw new UnauthorizedException(); // session tasks not finished in Clerk

    const named = header(req, 'x-tenant-id');
    let where: { tenantId: string } | { clerkOrgId: string };
    if (named !== undefined) {
      const tenantId = TenantIdHeader.safeParse(named);
      if (!tenantId.success) throw new BadRequestException('X-Tenant-Id must be a UUID');
      where = { tenantId: tenantId.data };
    } else if (claims.o) where = { clerkOrgId: claims.o.id };
    else throw new BadRequestException('choose a tenant: X-Tenant-Id or an active organization');

    const access = await resolveAccess(this.pool, claims.sub, where, claims.o?.id); // client roles need the live org
    if (!access) throw new NotFoundException(); // same answer whether the tenant exists or not
    const role = Role.parse(access.role);
    Sentry.getIsolationScope().setTag('tenant_id', access.tenantId);
    if (role.startsWith('firm_') && (claims.fva?.[1] ?? -1) < 0) throw new ForbiddenException('firm roles need a second factor');
    if (!(PERMISSIONS[permission] as readonly string[]).includes(role)) throw new ForbiddenException();

    req.caller = { userId: claims.sub, tenantId: access.tenantId, role, requestId };
    return true;
  }
}
