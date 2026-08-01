import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { POST as actionsPost } from '@/app/api/admin/campaigns/[id]/actions/route';
import { GET as validateGet } from '@/app/api/admin/campaigns/[id]/validate/route';
import { POST as previewPost } from '@/app/api/admin/campaigns/[id]/preview/route';
import { GET as cronSend } from '@/app/api/cron/send/route';
import { GET as cronPurge } from '@/app/api/cron/purge/route';
import { GET as clickRedirect } from '@/app/api/t/c/[token]/route';
import { POST as importPost } from '@/app/api/admin/import/route';
import { withAdmin } from '@/lib/api/guard';
import { importAttestationsCollection } from '@/lib/db/collections';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import { buildClickToken } from '@/lib/crypto/tokens';
import {
  campaignVersionsCollection,
  campaignsCollection,
  listsCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { updateCampaignDraft } from '@/lib/campaigns';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createCampaign, createList, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { CampaignDoc, ListDoc } from '@/lib/types';

let list: ListDoc;
let campaign: CampaignDoc;

const AUTH = { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}` };

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignVersionsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await listsCollection()).deleteMany({}),
  ]);
  list = await createList();
  campaign = await createCampaign(list._id, { bodySource: validCampaignDoc() });
  const ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
});

afterEach(() => {
  resetSesAdapter();
  vi.restoreAllMocks();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function action(body: Record<string, unknown>, id = campaign._id.toHexString()) {
  return actionsPost(
    new Request(`https://mail.example.com/api/admin/campaigns/${id}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify(body),
    }),
    params(id),
  );
}

async function reload() {
  return (await campaignsCollection()).findOne({ _id: campaign._id });
}

describe('campaign scheduling actions', () => {
  it('schedules a campaign for a future time', async () => {
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const response = await action({ action: 'schedule', scheduledFor: when });

    expect(response.status).toBe(200);
    const doc = await reload();
    expect(doc?.status).toBe('scheduled');
    expect(doc?.scheduledFor?.toISOString()).toBe(when);
  });

  it('refuses a schedule in the past', async () => {
    const response = await action({
      action: 'schedule',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('in_the_past');
    expect((await reload())?.status).toBe('draft');
  });

  it('requires a scheduledFor value', async () => {
    expect((await action({ action: 'schedule' })).status).toBe(400);
  });

  it('unschedules back to draft', async () => {
    await action({
      action: 'schedule',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const response = await action({ action: 'unschedule' });

    expect(response.status).toBe(200);
    expect((await reload())?.status).toBe('draft');
  });
});

describe('version restore action', () => {
  it('restores a previous version', async () => {
    await updateCampaignDraft({ campaignId: campaign._id, subject: 'Replacement' });
    const version = await (await campaignVersionsCollection()).findOne({
      campaignId: campaign._id,
    });

    const response = await action({
      action: 'restore',
      versionId: version!._id.toHexString(),
    });

    expect(response.status).toBe(200);
    expect((await reload())?.subject).toBe('This week from Domain A');
  });

  it('requires a valid versionId', async () => {
    expect((await action({ action: 'restore' })).status).toBe(400);
    expect((await action({ action: 'restore', versionId: 'nonsense' })).status).toBe(400);
  });
});

describe('action route guards', () => {
  it('rejects a malformed campaign id', async () => {
    const response = await action({ action: 'pause' }, 'not-an-object-id');
    expect(response.status).toBe(400);
  });

  it('404s for a campaign that does not exist', async () => {
    const response = await action({ action: 'pause' }, new ObjectId().toHexString());
    expect(response.status).toBe(404);
  });

  it('rejects a test send with no addresses', async () => {
    const response = await action({ action: 'test', to: [] });
    expect(response.status).toBe(400);
  });

  it('ignores non-string entries in a test address list', async () => {
    const response = await action({ action: 'test', to: [42, null] });
    expect(response.status).toBe(400);
  });
});

describe('validate and preview guards', () => {
  it('rejects a malformed campaign id on validate', async () => {
    const response = await validateGet(
      new Request('https://mail.example.com/api/admin/campaigns/x/validate', { headers: AUTH }),
      params('not-an-id'),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a malformed campaign id on preview', async () => {
    const response = await previewPost(
      new Request('https://mail.example.com/api/admin/campaigns/x/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: '{}',
      }),
      params('not-an-id'),
    );
    expect(response.status).toBe(400);
  });

  it('404s a preview for a campaign that does not exist', async () => {
    const missing = new ObjectId().toHexString();
    const response = await previewPost(
      new Request('https://mail.example.com/api/admin/campaigns/x/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: '{}',
      }),
      params(missing),
    );
    expect(response.status).toBe(404);
  });

  it('reports a render failure as 422 rather than pretending it rendered', async () => {
    const render = await import('@/lib/render/campaign');
    vi.spyOn(render, 'renderCampaignPreview').mockRejectedValue(new Error('MJML exploded'));

    const response = await previewPost(
      new Request('https://mail.example.com/api/admin/campaigns/x/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: '{}',
      }),
      params(campaign._id.toHexString()),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('MJML exploded');
  });
});

describe('cron routes surface failure without leaking detail', () => {
  function cronRequest(path: string) {
    return new Request(`https://mail.example.com${path}`, {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
  }

  it('answers 500 when the send cycle throws', async () => {
    // A thrown run leaves its batches leased; the next tick reclaims them.
    const run = await import('@/lib/pipeline/run');
    vi.spyOn(run, 'runSendCycle').mockRejectedValue(new Error('mongo unreachable'));

    const response = await cronSend(cronRequest('/api/cron/send'));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('mongo unreachable');
  });

  it('answers 500 when the purge throws', async () => {
    const subscribers = await import('@/lib/subscribers');
    vi.spyOn(subscribers, 'purgeExpiredPending').mockRejectedValue(new Error('index missing'));

    const response = await cronPurge(cronRequest('/api/cron/purge'));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('index missing');
  });
});

describe('click redirect allowlist', () => {
  // The click route names its parameter `token`, not `id`.
  const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

  afterEach(() => {
    delete process.env.TRACKING_URL_ALLOWLIST;
  });

  it('refuses a signed target that is not on the allowlist', async () => {
    // The signature proves we minted it; the allowlist proves we are still
    // willing to send people there.
    process.env.TRACKING_URL_ALLOWLIST = 'example.com';
    const token = buildClickToken({
      campaignId: campaign._id.toHexString(),
      linkIndex: 0,
      url: 'https://somewhere-else.test/page',
    });

    const response = await clickRedirect(
      new Request('https://mail.example.com/api/t/c/x'),
      tokenParams(token),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('follows a signed target that is on the allowlist', async () => {
    process.env.TRACKING_URL_ALLOWLIST = 'example.com';
    const token = buildClickToken({
      campaignId: campaign._id.toHexString(),
      linkIndex: 0,
      url: 'https://example.com/post',
    });

    const response = await clickRedirect(
      new Request('https://mail.example.com/api/t/c/x'),
      tokenParams(token),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/post');
  });
});


describe('withAdmin never lets a handler escape', () => {
  it('returns 500 even when the handler rejects with a bare null', async () => {
    // Reading `.message` off a non-Error would throw inside the catch, so the
    // wrapper would escape without returning the 500 it exists to guarantee.
    const handler = withAdmin(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw null;
    });

    const response = await handler(
      new Request('https://mail.example.com/api/admin/anything', { headers: AUTH }),
      undefined,
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('internal error');
  });

  it('returns 500 without leaking the handler error', async () => {
    const handler = withAdmin(async () => {
      throw new Error('connection string is mongodb+srv://user:hunter2@host');
    });

    const response = await handler(
      new Request('https://mail.example.com/api/admin/anything', { headers: AUTH }),
      undefined,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('hunter2');
  });
});

describe('the import route checks the list exists', () => {
  function importRequest(body: Record<string, unknown>) {
    return importPost(
      new Request('https://mail.example.com/api/admin/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify(body),
      }),
      undefined,
    );
  }

  it('rejects a well-formed id that names no list', async () => {
    // Otherwise the import creates subscribers nobody can see and nobody can
    // ever send to, plus a consent record against a list that does not exist.
    const response = await importRequest({
      listId: new ObjectId().toHexString(),
      csv: 'email\na@example.com\n',
      mapping: { email: 'email' },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('unknown list');
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
    expect(await (await importAttestationsCollection()).countDocuments()).toBe(0);
  });

  it('refuses to treat a whitespace-only attester as an attestation', async () => {
    // The attestation is the legal record for importing addresses as confirmed.
    const response = await importRequest({
      listId: list._id.toHexString(),
      csv: 'email\na@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: true,
      attestation: { text: 'prior consent held', by: '   ' },
    });

    expect(response.status).toBe(400);
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
  });

  it('accepts a genuine attestation', async () => {
    const response = await importRequest({
      listId: list._id.toHexString(),
      csv: 'email\na@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: true,
      attestation: { text: 'prior consent held', by: 'operator@example.com' },
    });

    expect(response.status).toBe(200);
    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.status).toBe('confirmed');
  });
});
