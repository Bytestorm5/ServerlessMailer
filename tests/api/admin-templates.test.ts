import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import { emailTemplatesCollection, listsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { DEFAULT_TEMPLATE_HTML } from '@/lib/render/template';
import { getTemplateHtml, saveTemplate } from '@/lib/templates';
import { createList } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

import {
  DELETE as templateDelete,
  GET as templateGet,
  PUT as templatePut,
} from '@/app/api/admin/templates/[listId]/[kind]/route';
import { POST as templatePreviewPost } from '@/app/api/admin/templates/[listId]/[kind]/preview/route';

/** Template routes (§6.2a), including the admin guard on every one. */

const AUTH = { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}` };
const MINIMAL = '<html><body><h1>{{list_name}}</h1>{{content}}</body></html>';
const CONFIRMATION =
  '<html><body><h1>{{list_name}}</h1><a href="{{confirm_url}}">Confirm</a></body></html>';

function req(body?: unknown, authed = true): Request {
  return new Request('https://mail.example.com/api/admin/templates/x', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authed ? AUTH : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (listId: string, kind = 'campaign') => ({
  params: Promise.resolve({ listId, kind }),
});

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await listsCollection()).deleteMany({}),
    (await emailTemplatesCollection()).deleteMany({}),
  ]);
  list = await createList();
});

describe('GET /api/admin/templates/[listId]', () => {
  it('answers with the default for a list that has not chosen one', async () => {
    const response = await templateGet(req(), params(list._id.toHexString()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, stored: false, html: DEFAULT_TEMPLATE_HTML });
  });

  it('answers with the stored template once there is one', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    const body = await (await templateGet(req(), params(list._id.toHexString()))).json();

    expect(body).toMatchObject({ ok: true, stored: true, html: MINIMAL });
  });

  it('rejects a malformed list id', async () => {
    expect((await templateGet(req(), params('not-an-id'))).status).toBe(400);
  });

  it('requires an admin session', async () => {
    const response = await templateGet(req(undefined, false), params(list._id.toHexString()));
    expect(response.status).toBe(401);
  });
});

describe('PUT /api/admin/templates/[listId]', () => {
  it('stores a valid template', async () => {
    const response = await templatePut(req({ html: MINIMAL }), params(list._id.toHexString()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: true });
    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
  });

  it('reports every problem at once rather than the first', async () => {
    const response = await templatePut(
      req({ html: '<body><p>Hi {{first_name}} {{ nonsense }}</p></body>' }),
      params(list._id.toHexString()),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errors.length).toBeGreaterThan(1);
    expect(await getTemplateHtml(list._id, 'campaign')).toBeNull();
  });

  it('reports what the sanitizer stripped alongside a successful save', async () => {
    const body = await (
      await templatePut(req({ html: `<script>x</script>${MINIMAL}` }), params(list._id.toHexString()))
    ).json();

    expect(body).toMatchObject({ ok: true, removed: ['<script>'] });
  });

  it('404s for a list that does not exist', async () => {
    const response = await templatePut(req({ html: MINIMAL }), params(new ObjectId().toHexString()));
    expect(response.status).toBe(404);
  });

  it('rejects a body that is not JSON', async () => {
    const request = new Request('https://mail.example.com/api/admin/templates/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: 'not json',
    });
    expect((await templatePut(request, params(list._id.toHexString()))).status).toBe(400);
  });

  it('requires an admin session', async () => {
    const response = await templatePut(
      req({ html: MINIMAL }, false),
      params(list._id.toHexString()),
    );
    expect(response.status).toBe(401);
    expect(await getTemplateHtml(list._id, 'campaign')).toBeNull();
  });
});

describe('DELETE /api/admin/templates/[listId]', () => {
  it('returns the list to the built-in layout', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    const body = await (
      await templateDelete(req(), params(list._id.toHexString()))
    ).json();

    expect(body).toMatchObject({ ok: true, removed: true, stored: false });
    expect(await getTemplateHtml(list._id, 'campaign')).toBeNull();
  });

  it('is a no-op for a list that never had one', async () => {
    const body = await (await templateDelete(req(), params(list._id.toHexString()))).json();
    expect(body).toMatchObject({ ok: true, removed: false });
  });

  it('requires an admin session', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    const response = await templateDelete(req(undefined, false), params(list._id.toHexString()));

    expect(response.status).toBe(401);
    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
  });
});

describe('POST /api/admin/templates/[listId]/preview', () => {
  it('renders an unsaved template without storing it', async () => {
    const response = await templatePreviewPost(
      req({ html: MINIMAL }),
      params(list._id.toHexString()),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.html).toContain(list.name);
    expect(await getTemplateHtml(list._id, 'campaign')).toBeNull();
  });

  it('surfaces a render failure as 422 rather than a blank preview', async () => {
    const response = await templatePreviewPost(
      req({ html: '<body>no slot</body>' }),
      params(list._id.toHexString()),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).errors.join(' ')).toContain('{{content}}');
  });

  it('404s for a list that does not exist', async () => {
    const response = await templatePreviewPost(
      req({ html: MINIMAL }),
      params(new ObjectId().toHexString()),
    );
    expect(response.status).toBe(404);
  });

  it('rejects a malformed list id and a non-JSON body', async () => {
    expect((await templatePreviewPost(req({ html: MINIMAL }), params('nope'))).status).toBe(400);

    const bad = new Request('https://mail.example.com/api/admin/templates/x/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: '{',
    });
    expect((await templatePreviewPost(bad, params(list._id.toHexString()))).status).toBe(400);
  });

  it('requires an admin session', async () => {
    const response = await templatePreviewPost(
      req({ html: MINIMAL }, false),
      params(list._id.toHexString()),
    );
    expect(response.status).toBe(401);
  });
});

describe('the kind in the path', () => {
  it('rejects a kind the renderer does not know', async () => {
    const response = await templateGet(req(), params(list._id.toHexString(), 'invoice'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('kind');
  });

  it('serves the confirmation default to a list that has not chosen one', async () => {
    const body = await (
      await templateGet(req(), params(list._id.toHexString(), 'confirmation'))
    ).json();

    expect(body).toMatchObject({ ok: true, kind: 'confirmation', stored: false });
    expect(body.html).toContain('{{confirm_url}}');
  });

  it('stores each kind independently', async () => {
    await templatePut(req({ html: MINIMAL }), params(list._id.toHexString(), 'campaign'));
    await templatePut(
      req({ html: CONFIRMATION }),
      params(list._id.toHexString(), 'confirmation'),
    );

    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
    expect(await getTemplateHtml(list._id, 'confirmation')).toBe(CONFIRMATION);
  });

  it('refuses a campaign template stored as a confirmation one', async () => {
    const response = await templatePut(
      req({ html: MINIMAL }),
      params(list._id.toHexString(), 'confirmation'),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).errors.join(' ')).toContain('{{confirm_url}}');
  });

  it('deletes one kind without touching the other', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    await saveTemplate(list._id, 'confirmation', CONFIRMATION);

    await templateDelete(req(), params(list._id.toHexString(), 'confirmation'));

    expect(await getTemplateHtml(list._id, 'confirmation')).toBeNull();
    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
  });

  it('previews a confirmation template', async () => {
    const response = await templatePreviewPost(
      req({ html: CONFIRMATION }),
      params(list._id.toHexString(), 'confirmation'),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).html).toContain('https://example.com/confirm');
  });

  it('rejects an unknown kind on the preview route too', async () => {
    const response = await templatePreviewPost(
      req({ html: CONFIRMATION }),
      params(list._id.toHexString(), 'receipt'),
    );
    expect(response.status).toBe(400);
  });
});
