import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import {
  campaignsCollection,
  listsCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';

import { GET as listsGet, POST as listsPost } from '@/app/api/admin/lists/route';
import {
  DELETE as listDelete,
  GET as listGet,
  PATCH as listPatch,
} from '@/app/api/admin/lists/[id]/route';

/** List configuration routes (§3.1), including the admin guard on every one. */

const AUTH = { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}` };
const url = (path: string) => `https://mail.example.com${path}`;

function req(path: string, init: RequestInit = {}, authed = true): Request {
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

const VALID = {
  name: 'Domain B Monthly',
  sendingDomain: 'news.domain-b.com',
  fromName: 'Domain B',
  fromEmail: 'hello@news.domain-b.com',
  replyTo: 'hello@domain-b.com',
  physicalAddress: '2 Example Road, Bristol, BS1 1AA, United Kingdom',
  sesConfigurationSet: 'domain-b-config',
  welcomeUrl: 'https://domain-b.com/welcome',
};

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await listsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
  ]);
});

describe('the admin guard', () => {
  it('rejects every list route without a session', async () => {
    const id = new ObjectId().toHexString();
    const responses = await Promise.all([
      listsGet(req('/api/admin/lists', {}, false), undefined),
      listsPost(req('/api/admin/lists', { method: 'POST', body: '{}' }, false), undefined),
      listGet(req(`/api/admin/lists/${id}`, {}, false), params(id)),
      listPatch(
        req(`/api/admin/lists/${id}`, { method: 'PATCH', body: '{}' }, false),
        params(id),
      ),
      listDelete(req(`/api/admin/lists/${id}`, { method: 'DELETE' }, false), params(id)),
    ]);

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
  });
});

describe('GET /api/admin/lists', () => {
  it('returns every list with the counts the delete guard uses', async () => {
    const list = await createList();
    await createSubscriber(list._id, { email: 'a@example.com', status: 'confirmed' });
    await createSubscriber(list._id, { email: 'b@example.com', status: 'pending' });
    await createCampaign(list._id);

    const response = await listsGet(req('/api/admin/lists'), undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0]).toMatchObject({
      id: list._id.toHexString(),
      name: 'Domain A Weekly',
      sendingDomain: 'news.domain-a.com',
      active: true,
      counts: { confirmed: 1, pending: 1, campaigns: 1 },
    });
  });
});

describe('POST /api/admin/lists', () => {
  it('creates a list and returns 201', async () => {
    const response = await listsPost(
      req('/api/admin/lists', { method: 'POST', body: JSON.stringify(VALID) }),
      undefined,
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.list).toMatchObject({
      name: 'Domain B Monthly',
      sendingDomain: 'news.domain-b.com',
      active: true,
    });
    expect(await (await listsCollection()).countDocuments({})).toBe(1);
  });

  it('turns a validation failure into a 400 that explains itself', async () => {
    const response = await listsPost(
      req('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({ ...VALID, fromEmail: 'hello@somewhere-else.com' }),
      }),
      undefined,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/verified SES identity/);
    expect(await (await listsCollection()).countDocuments({})).toBe(0);
  });

  it('rejects a non-JSON body', async () => {
    const response = await listsPost(
      req('/api/admin/lists', { method: 'POST', body: 'not json' }),
      undefined,
    );
    expect(response.status).toBe(400);
  });

  it('honours an explicit active:false', async () => {
    const response = await listsPost(
      req('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({ ...VALID, active: false }),
      }),
      undefined,
    );
    expect((await response.json()).list.active).toBe(false);
  });
});

describe('GET /api/admin/lists/[id]', () => {
  it('returns one list', async () => {
    const list = await createList();
    const id = list._id.toHexString();
    const response = await listGet(req(`/api/admin/lists/${id}`), params(id));

    expect(response.status).toBe(200);
    expect((await response.json()).list.id).toBe(id);
  });

  it('400s an unparseable id and 404s an unknown one', async () => {
    expect((await listGet(req('/api/admin/lists/nope'), params('nope'))).status).toBe(400);

    const missing = new ObjectId().toHexString();
    expect(
      (await listGet(req(`/api/admin/lists/${missing}`), params(missing))).status,
    ).toBe(404);
  });
});

describe('PATCH /api/admin/lists/[id]', () => {
  it('applies a one-field patch without blanking the rest', async () => {
    const list = await createList();
    const id = list._id.toHexString();

    const response = await listPatch(
      req(`/api/admin/lists/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fromName: 'Domain A Newsletter' }),
      }),
      params(id),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.list.fromName).toBe('Domain A Newsletter');
    expect(body.list.physicalAddress).toBe(list.physicalAddress);
  });

  it('toggles active', async () => {
    const list = await createList();
    const id = list._id.toHexString();

    const response = await listPatch(
      req(`/api/admin/lists/${id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }),
      params(id),
    );
    expect((await response.json()).list.active).toBe(false);
  });

  it('rejects a patch whose merged result would be unsendable', async () => {
    const list = await createList();
    const id = list._id.toHexString();

    const response = await listPatch(
      req(`/api/admin/lists/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sendingDomain: 'news.domain-z.com' }),
      }),
      params(id),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/verified SES identity/);
  });

  it('rejects a body with no editable field', async () => {
    const list = await createList();
    const id = list._id.toHexString();

    const response = await listPatch(
      req(`/api/admin/lists/${id}`, {
        method: 'PATCH',
        // `createdAt` is the database's, not the operator's.
        body: JSON.stringify({ createdAt: '2020-01-01', _id: 'x' }),
      }),
      params(id),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/no editable fields/);
  });

  it('404s an unknown list', async () => {
    const missing = new ObjectId().toHexString();
    const response = await listPatch(
      req(`/api/admin/lists/${missing}`, {
        method: 'PATCH',
        body: JSON.stringify({ fromName: 'x' }),
      }),
      params(missing),
    );
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/admin/lists/[id]', () => {
  it('deletes a list nothing references', async () => {
    const list = await createList();
    const id = list._id.toHexString();

    const response = await listDelete(
      req(`/api/admin/lists/${id}`, { method: 'DELETE' }),
      params(id),
    );

    expect(response.status).toBe(200);
    expect(await (await listsCollection()).countDocuments({})).toBe(0);
  });

  it('409s a list with subscribers, and keeps it', async () => {
    const list = await createList();
    const id = list._id.toHexString();
    await createSubscriber(list._id, { email: 'a@example.com' });

    const response = await listDelete(
      req(`/api/admin/lists/${id}`, { method: 'DELETE' }),
      params(id),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.subscribers).toBe(1);
    expect(body.error).toMatch(/Deactivate the list instead/);
    expect(await (await listsCollection()).countDocuments({})).toBe(1);
  });

  it('400s an unparseable id and 404s an unknown one', async () => {
    expect(
      (await listDelete(req('/api/admin/lists/nope', { method: 'DELETE' }), params('nope')))
        .status,
    ).toBe(400);

    const missing = new ObjectId().toHexString();
    expect(
      (
        await listDelete(
          req(`/api/admin/lists/${missing}`, { method: 'DELETE' }),
          params(missing),
        )
      ).status,
    ).toBe(404);
  });
});
