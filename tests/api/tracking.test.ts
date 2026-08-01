import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { GET as openPixel } from '@/app/api/t/o/[token]/route';
import { GET as clickRedirect } from '@/app/api/t/c/[token]/route';
import { buildClickToken, buildRecipientToken } from '@/lib/crypto/tokens';
import { campaignsCollection, eventsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import type { CampaignDoc, ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;
let campaign: CampaignDoc;
let subscriber: SubscriberDoc;
let recipientToken: string;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await eventsCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
  ]);
  list = await createList();
  campaign = await createCampaign(list._id, { trackOpens: true, trackClicks: true });
  subscriber = await createSubscriber(list._id, { email: 'reader@example.com' });
  recipientToken = buildRecipientToken(
    subscriber._id.toHexString(),
    campaign._id.toHexString(),
  );
});

const params = (token: string) => ({ params: Promise.resolve({ token }) });

async function counts() {
  return (await (await campaignsCollection()).findOne({ _id: campaign._id }))?.counts;
}

describe('GET /api/t/o/[token] — open pixel', () => {
  it('returns a 1x1 GIF', async () => {
    const response = await openPixel(
      new Request('https://mail.example.com/api/t/o/x'),
      params(recipientToken),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // GIF magic number.
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe('GIF');
  });

  it('records the open and counts it once per subscriber', async () => {
    await openPixel(new Request('https://x/'), params(recipientToken));
    await openPixel(new Request('https://x/'), params(recipientToken));

    // Repeat views are recorded as events but the headline count stays unique,
    // so it is not inflated by one person reopening an email.
    expect((await counts())?.opened).toBe(1);
    expect(
      await (await eventsCollection()).countDocuments({ type: 'open' }),
    ).toBe(1);
  });

  it('is never cached, so a reopen still reaches the server', async () => {
    const response = await openPixel(new Request('https://x/'), params(recipientToken));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('still returns a valid image for a forged token', async () => {
    // A broken image in an email looks like a broken email. Failing closed here
    // means recording nothing, not serving an error.
    const response = await openPixel(new Request('https://x/'), params('not-a-token'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(await (await eventsCollection()).countDocuments()).toBe(0);
  });

  it('tolerates a filename suffix on the token', async () => {
    const response = await openPixel(
      new Request('https://x/'),
      params(`${recipientToken}.gif`),
    );

    expect(response.status).toBe(200);
    expect((await counts())?.opened).toBe(1);
  });
});

describe('GET /api/t/c/[token] — click redirect', () => {
  function clickToken(url: string, linkIndex = 0) {
    return buildClickToken({ campaignId: campaign._id.toHexString(), linkIndex, url });
  }

  it('redirects to the signed target', async () => {
    const token = clickToken('https://example.com/post');
    const response = await clickRedirect(
      new Request(`https://mail.example.com/api/t/c/${token}?r=${recipientToken}`),
      params(token),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/post');
  });

  it('records the click with its target URL', async () => {
    const token = clickToken('https://example.com/post');
    await clickRedirect(
      new Request(`https://x/?r=${recipientToken}`),
      params(token),
    );

    const event = await (await eventsCollection()).findOne({ type: 'click' });
    expect(event?.url).toBe('https://example.com/post');
    expect(event?.subscriberId?.toHexString()).toBe(subscriber._id.toHexString());
    expect((await counts())?.clicked).toBe(1);
  });

  it('counts a repeat click once per subscriber', async () => {
    const token = clickToken('https://example.com/post');
    const request = new Request(`https://x/?r=${recipientToken}`);
    await clickRedirect(request, params(token));
    await clickRedirect(new Request(`https://x/?r=${recipientToken}`), params(token));

    expect((await counts())?.clicked).toBe(1);
  });

  it('refuses an unsigned or tampered token instead of redirecting', async () => {
    // §12: an unsigned redirector is an open redirect and will be abused.
    for (const bad of ['garbage', '', 'aHR0cHM6Ly9ldmlsLmV4YW1wbGU']) {
      const response = await clickRedirect(new Request('https://x/'), params(bad));
      expect(response.status).not.toBe(302);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('refuses a token whose payload was swapped for another target', async () => {
    const token = clickToken('https://example.com/post');
    const forged = `${Buffer.from('{"campaignId":"x","linkIndex":0,"url":"https://evil.example"}').toString('base64url')}.${token.split('.')[1]}`;

    const response = await clickRedirect(new Request('https://x/'), params(forged));

    expect(response.status).not.toBe(302);
  });

  it('redirects even when the recipient token is missing, but records no subscriber', async () => {
    // A forwarded email loses the recipient parameter; the reader should still
    // reach the article.
    const token = clickToken('https://example.com/post');
    const response = await clickRedirect(new Request('https://x/'), params(token));

    expect(response.status).toBe(302);
    const event = await (await eventsCollection()).findOne({ type: 'click' });
    expect(event?.subscriberId).toBeUndefined();
  });

  it('is not cached', async () => {
    const token = clickToken('https://example.com/post');
    const response = await clickRedirect(new Request('https://x/'), params(token));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
