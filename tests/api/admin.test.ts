import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import {
  campaignsCollection,
  rateLimitsCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createCampaign, createList, createSubscriber, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { CampaignDoc, ListDoc } from '@/lib/types';

import { POST as sessionPost } from '@/app/api/admin/session/route';
import { GET as campaignsGet, POST as campaignsPost } from '@/app/api/admin/campaigns/route';
import { GET as campaignGet, PATCH as campaignPatch } from '@/app/api/admin/campaigns/[id]/route';
import { POST as actionsPost } from '@/app/api/admin/campaigns/[id]/actions/route';
import { GET as validateGet } from '@/app/api/admin/campaigns/[id]/validate/route';
import { POST as previewPost } from '@/app/api/admin/campaigns/[id]/preview/route';
import { GET as subscribersGet } from '@/app/api/admin/subscribers/route';
import {
  DELETE as suppressionsDelete,
  GET as suppressionsGet,
  POST as suppressionsPost,
} from '@/app/api/admin/suppressions/route';
import { GET as exportGet } from '@/app/api/admin/export/route';
import { POST as segmentPost } from '@/app/api/admin/segment/route';

let list: ListDoc;
let campaign: CampaignDoc;
let ses: FakeSes;

const AUTH = { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}` };

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await rateLimitsCollection()).deleteMany({}),
  ]);
  list = await createList();
  campaign = await createCampaign(list._id, { bodySource: validCampaignDoc() });
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
});

afterEach(() => {
  resetSesAdapter();
});

const url = (path: string) => `https://mail.example.com${path}`;

function req(path: string, init: RequestInit = {}, authed = true) {
  return new Request(url(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(authed ? AUTH : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('admin routes require a session', () => {
  it('rejects every admin endpoint without a valid cookie', async () => {
    // §12: the admin UI is authenticated; there are no public write paths to
    // campaigns or subscribers.
    const unauthenticated: Promise<Response>[] = [
      campaignsGet(req('/api/admin/campaigns', {}, false), undefined),
      campaignsPost(req('/api/admin/campaigns', { method: 'POST', body: '{}' }, false), undefined),
      campaignGet(req('/api/admin/campaigns/x', {}, false), params(campaign._id.toHexString())),
      actionsPost(
        req('/api/admin/campaigns/x/actions', { method: 'POST', body: '{}' }, false),
        params(campaign._id.toHexString()),
      ),
      subscribersGet(req('/api/admin/subscribers', {}, false), undefined),
      suppressionsGet(req('/api/admin/suppressions', {}, false), undefined),
      exportGet(req('/api/admin/export', {}, false), undefined),
    ];

    for (const response of await Promise.all(unauthenticated)) {
      expect(response.status).toBe(401);
    }
  });

  it('rejects a tampered session cookie', async () => {
    const tampered = `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}x`;
    const response = await campaignsGet(
      new Request(url('/api/admin/campaigns'), { headers: { cookie: tampered } }),
      undefined,
    );
    expect(response.status).toBe(401);
  });

  it('does not write anything when unauthorised', async () => {
    await suppressionsPost(
      req('/api/admin/suppressions', {
        method: 'POST',
        body: JSON.stringify({ email: 'sneaky@example.com' }),
      }, false),
      undefined,
    );
    expect(await (await suppressionsCollection()).countDocuments()).toBe(0);
  });
});

describe('POST /api/admin/session', () => {
  it('sets an HttpOnly session cookie for the right password', async () => {
    const response = await sessionPost(
      new Request(url('/api/admin/session'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-admin-password' }),
      }),
    );

    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(ADMIN_COOKIE_NAME);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('rejects the wrong password without setting a cookie', async () => {
    const response = await sessionPost(
      new Request(url('/api/admin/session'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rate limits repeated attempts so the password cannot be brute forced', async () => {
    for (let i = 0; i < 10; i += 1) {
      await sessionPost(
        new Request(url('/api/admin/session'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: `guess-${i}` }),
        }),
      );
    }

    const response = await sessionPost(
      new Request(url('/api/admin/session'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-admin-password' }),
      }),
    );
    expect(response.status).toBe(429);
  });
});

describe('campaign routes', () => {
  it('lists and creates campaigns', async () => {
    const listed = await campaignsGet(req('/api/admin/campaigns'), undefined);
    expect((await listed.json()).campaigns).toHaveLength(1);

    const created = await campaignsPost(
      req('/api/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ listId: list._id.toHexString() }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    expect(await (await campaignsCollection()).countDocuments()).toBe(2);
  });

  it('rejects creating a campaign on an unknown list', async () => {
    const response = await campaignsPost(
      req('/api/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ listId: new ObjectId().toHexString() }),
      }),
      undefined,
    );
    expect(response.status).toBe(400);
  });

  it('returns a campaign with its list and versions', async () => {
    const response = await campaignGet(
      req(`/api/admin/campaigns/${campaign._id}`),
      params(campaign._id.toHexString()),
    );
    const body = await response.json();

    expect(body.campaign.id).toBe(campaign._id.toHexString());
    expect(body.list.fromEmail).toBe('hello@news.domain-a.com');
    expect(Array.isArray(body.versions)).toBe(true);
  });

  it('patches a draft', async () => {
    const response = await campaignPatch(
      req(`/api/admin/campaigns/${campaign._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject: 'Updated subject' }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.subject).toBe('Updated subject');
  });

  it('answers 409 when patching a campaign that is already sending', async () => {
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );

    const response = await campaignPatch(
      req(`/api/admin/campaigns/${campaign._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject: 'Too late' }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(409);
  });

  it('rejects an invalid body with the validation errors', async () => {
    const response = await campaignPatch(
      req(`/api/admin/campaigns/${campaign._id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          bodySource: { type: 'doc', content: [{ type: 'codeBlock' }] },
        }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).errors.length).toBeGreaterThan(0);
  });
});

describe('campaign actions', () => {
  it('refuses to send when the pre-send gate fails, returning the failing checks', async () => {
    // No confirmed subscribers, so recipient_count fails.
    const response = await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'send' }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.checks.some((c: { id: string; passed: boolean }) => !c.passed)).toBe(true);

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
  });

  it('freezes the campaign when everything passes', async () => {
    await createSubscriber(list._id, { email: 'ready@example.com' });

    const response = await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'send' }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sending');
  });

  it('sends a test without touching campaign counts', async () => {
    const response = await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'test', to: ['me@example.com'] }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    expect(ses.simpleSends).toHaveLength(1);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.counts.sent).toBe(0);
  });

  it('pauses and resumes a sending campaign', async () => {
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );

    await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'pause', reason: 'Bad subject' }),
      }),
      params(campaign._id.toHexString()),
    );
    expect((await (await campaignsCollection()).findOne({ _id: campaign._id }))?.status).toBe(
      'paused',
    );

    await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'resume' }),
      }),
      params(campaign._id.toHexString()),
    );
    expect((await (await campaignsCollection()).findOne({ _id: campaign._id }))?.status).toBe(
      'sending',
    );
  });

  it('rejects an unknown action', async () => {
    const response = await actionsPost(
      req(`/api/admin/campaigns/${campaign._id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'destroy-everything' }),
      }),
      params(campaign._id.toHexString()),
    );
    expect(response.status).toBe(400);
  });
});

describe('validate and preview', () => {
  it('reports the pre-send checks', async () => {
    const response = await validateGet(
      req(`/api/admin/campaigns/${campaign._id}/validate`),
      params(campaign._id.toHexString()),
    );
    const body = await response.json();

    expect(body.passed).toBe(false);
    expect(body.checks.find((c: { id: string }) => c.id === 'recipient_count').passed).toBe(false);
  });

  it('renders an unsaved draft with a real subscriber’s merge data', async () => {
    await createSubscriber(list._id, {
      email: 'ada@example.com',
      attributes: { first_name: 'Ada' },
    });

    const response = await previewPost(
      req(`/api/admin/campaigns/${campaign._id}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          subject: 'Unsaved subject',
          bodySource: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Hi {{ first_name | default: "there" }}' }],
              },
            ],
          },
        }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.subject).toBe('Unsaved subject');
    expect(body.html).toContain('Ada');
    expect(body.html).not.toContain('{{');
  });

  it('rejects a preview of an invalid body', async () => {
    const response = await previewPost(
      req(`/api/admin/campaigns/${campaign._id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ bodySource: { type: 'doc', content: [{ type: 'iframe' }] } }),
      }),
      params(campaign._id.toHexString()),
    );
    expect(response.status).toBe(400);
  });

  it('previews an unsaved HTML body through the list template', async () => {
    const { saveTemplate } = await import('@/lib/templates');
    await saveTemplate(
      list._id,
      'campaign',
      '<html><body><div class="shell">{{content}}</div>' +
        '<p>{{physical_address}}</p><a href="{{unsubscribe_url}}">Out</a></body></html>',
    );

    const response = await previewPost(
      req(`/api/admin/campaigns/${campaign._id}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          bodyMode: 'html',
          bodyHtmlSource: '<table><tr><td>Pasted markup</td></tr></table>',
        }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.html).toContain('class="shell"');
    expect(body.html).toContain('Pasted markup');
    expect(body.text).toContain('Pasted markup');
  });

  it('ignores a body mode the renderer does not know', async () => {
    // Storing it would render as nothing at all.
    const response = await previewPost(
      req(`/api/admin/campaigns/${campaign._id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ bodyMode: 'interpretive-dance' }),
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).html).toContain('<html');
  });
});

describe('subscribers, suppressions, segments and export', () => {
  it('lists subscribers with a total', async () => {
    await createSubscriber(list._id, { email: 'a@example.com' });
    await createSubscriber(list._id, { email: 'b@example.com', status: 'pending' });

    const response = await subscribersGet(
      req(`/api/admin/subscribers?listId=${list._id}&status=confirmed`),
      undefined,
    );
    const body = await response.json();

    expect(body.total).toBe(1);
    expect(body.subscribers[0].email).toBe('a@example.com');
  });

  it('adds and removes a manual suppression', async () => {
    const added = await suppressionsPost(
      req('/api/admin/suppressions', {
        method: 'POST',
        body: JSON.stringify({ email: 'manual@example.com' }),
      }),
      undefined,
    );
    expect((await added.json()).created).toBe(true);

    const listed = await suppressionsGet(req('/api/admin/suppressions'), undefined);
    expect((await listed.json()).total).toBe(1);

    const removed = await suppressionsDelete(
      req('/api/admin/suppressions?email=manual@example.com', { method: 'DELETE' }),
      undefined,
    );
    expect((await removed.json()).removed).toBe(true);
  });

  it('rejects a malformed suppression address', async () => {
    const response = await suppressionsPost(
      req('/api/admin/suppressions', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-email' }),
      }),
      undefined,
    );
    expect(response.status).toBe(400);
  });

  it('counts a segment live', async () => {
    await createSubscriber(list._id, { email: 'x@example.com', attributes: { city: 'London' } });
    await createSubscriber(list._id, { email: 'y@example.com', attributes: { city: 'Paris' } });

    const response = await segmentPost(
      req('/api/admin/segment', {
        method: 'POST',
        body: JSON.stringify({
          listId: list._id.toHexString(),
          query: { attributeEquals: [{ key: 'city', value: 'London' }] },
        }),
      }),
      undefined,
    );

    expect((await response.json()).count).toBe(1);
  });

  it('rejects a segment with an unsafe attribute key', async () => {
    const response = await segmentPost(
      req('/api/admin/segment', {
        method: 'POST',
        body: JSON.stringify({
          listId: list._id.toHexString(),
          query: { attributeEquals: [{ key: '$where', value: 'x' }] },
        }),
      }),
      undefined,
    );
    expect(response.status).toBe(400);
  });

  it('exports subscribers as a downloadable CSV', async () => {
    await createSubscriber(list._id, { email: 'export@example.com' });

    const response = await exportGet(
      req(`/api/admin/export?listId=${list._id}`),
      undefined,
    );

    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.text()).toContain('export@example.com');
  });

  it('exports the suppression list separately', async () => {
    await suppressionsPost(
      req('/api/admin/suppressions', {
        method: 'POST',
        body: JSON.stringify({ email: 'sup@example.com' }),
      }),
      undefined,
    );

    const response = await exportGet(req('/api/admin/export?what=suppressions'), undefined);
    expect(await response.text()).toContain('sup@example.com');
  });
});
