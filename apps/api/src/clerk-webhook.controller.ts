import { BadRequestException, Controller, HttpCode, Inject, Logger, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { z } from 'zod';
import type pg from 'pg';
import { applyMembershipEvent, revokeOrganization } from '@app/db';
import { Public } from './auth/permissions.js';
import { HOOK_POOL } from './db.js';

// Clerk role keys we mirror (custom roles set up in the Clerk dashboard). Any other role, Clerk's default org:admin
// and org:member included, grants nothing: we never guess a role.
const ROLE_OF = new Map([['org:client_owner', 'client_owner'], ['org:client_staff', 'client_staff'], ['org:client_viewer', 'client_viewer']]);

const MEMBERSHIP = ['organizationMembership.created', 'organizationMembership.updated', 'organizationMembership.deleted'];
const Event = z.object({ type: z.string(), timestamp: z.number().int().positive(), data: z.unknown() });
// What we need from each event we act on (types: @clerk/backend OrganizationMembershipJSON, DeletedObjectJSON).
// role is only read on created/updated; a deletion needs only who and where.
const Member = z.object({ organization: z.object({ id: z.string().min(1) }), public_user_data: z.object({ user_id: z.string().min(1) }) });
const MemberWithRole = Member.extend({ role: z.string() });
const DeletedOrg = z.object({ id: z.string().min(1) });

type RawReq = { rawBody?: Buffer; headersDistinct: Record<string, string[] | undefined>; originalUrl: string };

/**
 * Clerk → memberships (spec: webhooks verified by their Svix signature, processed idempotently). Public because the
 * signature is the authentication. 2xx stops Clerk retrying; 4xx/5xx makes it retry. An event type we act on that we
 * can't read is a 500 (retried, and Sentry sees it), never a silent 200, so a removal is never dropped.
 */
@Controller('webhooks/clerk')
export class ClerkWebhookController {
  constructor(@Inject(HOOK_POOL) private readonly hookPool: pg.Pool | null) {}

  @Post()
  @Public()
  @HttpCode(200)
  async receive(@Req() req: RawReq): Promise<{ result: string }> {
    const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (!signingSecret || !this.hookPool) throw new ServiceUnavailableException(); // Clerk retries until configured
    if (!req.rawBody) throw new BadRequestException();
    const headers = new Headers();
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const v = req.headersDistinct[name];
      if (v?.length !== 1 || v[0] === undefined) throw new BadRequestException();
      headers.set(name, v[0]);
    }
    const svixId = headers.get('svix-id') ?? '';
    let verified: unknown;
    try {
      verified = await verifyWebhook(new Request(`http://api${req.originalUrl}`, { method: 'POST', headers, body: new Uint8Array(req.rawBody) }), { signingSecret });
    } catch {
      throw new BadRequestException(); // bad or stale signature: nothing about why goes back
    }
    const event = Event.parse(verified); // signed by Clerk but not even an event: 500, retried, Sentry
    const eventMs = BigInt(event.timestamp);
    let result: string;
    let org: string;
    if (MEMBERSHIP.includes(event.type)) {
      const data = Member.parse(event.data);
      org = data.organization.id;
      const role = event.type === 'organizationMembership.deleted' ? null : (ROLE_OF.get(MemberWithRole.parse(event.data).role) ?? null);
      result = await applyMembershipEvent(this.hookPool, { clerkOrgId: org, clerkUserId: data.public_user_data.user_id, role, eventMs });
    } else if (event.type === 'organization.deleted') {
      org = DeletedOrg.parse(event.data).id;
      result = await revokeOrganization(this.hookPool, org, eventMs);
    } else return { result: 'ignored' };

    if (result === 'no_tenant') {
      // Fails closed (nobody gains access), but a member event for an org we haven't linked yet is worth a look.
      Logger.warn(`${event.type} for unlinked org ${org} (svix ${svixId})`, 'ClerkWebhook');
      Sentry.captureMessage('Clerk webhook for an org with no tenant', { level: 'warning', tags: { svix_id: svixId, clerk_org: org } });
    } else Logger.log(`${event.type} ${result} org ${org} (svix ${svixId})`, 'ClerkWebhook');
    return { result };
  }
}
