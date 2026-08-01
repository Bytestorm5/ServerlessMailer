import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  createCampaign,
  listCampaignVersions,
  pauseCampaign,
  restoreCampaignVersion,
  resumeCampaign,
  scheduleCampaign,
  sendTestEmail,
  unscheduleCampaign,
  updateCampaignDraft,
} from '@/lib/campaigns';
import {
  campaignVersionsCollection,
  campaignsCollection,
  sentLogCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createList, createSubscriber, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { EditorDoc, ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignVersionsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
});

afterEach(() => {
  resetSesAdapter();
});

const doc = (text: string): EditorDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('createCampaign', () => {
  it('creates an empty draft on the list', async () => {
    const campaign = await createCampaign({ listId: list._id });

    expect(campaign.status).toBe('draft');
    expect(campaign.counts.recipients).toBe(0);
    expect(campaign.trackOpens).toBe(false);
    expect(campaign.bodySource.type).toBe('doc');
  });
});

describe('updateCampaignDraft', () => {
  it('updates the fields it is given and leaves the rest alone', async () => {
    const campaign = await createCampaign({ listId: list._id, subject: 'Original' });

    const result = await updateCampaignDraft({
      campaignId: campaign._id,
      preheader: 'A short line',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.campaign.subject).toBe('Original');
    expect(result.campaign.preheader).toBe('A short line');
  });

  it('rejects a body containing an unsupported node', async () => {
    const campaign = await createCampaign({ listId: list._id });

    const result = await updateCampaignDraft({
      campaignId: campaign._id,
      bodySource: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf' }] }],
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_body' });
  });

  it('rejects a link with a javascript: href', async () => {
    const campaign = await createCampaign({ listId: list._id });

    const result = await updateCampaignDraft({
      campaignId: campaign._id,
      bodySource: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'click',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_body' });
  });

  it('refuses to edit a campaign that is already sending', async () => {
    // §7.1: after freeze the body is immutable. A template change mid-send must
    // not produce two different emails.
    const campaign = await createCampaign({ listId: list._id });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );

    const result = await updateCampaignDraft({
      campaignId: campaign._id,
      subject: 'Too late',
    });

    expect(result).toEqual({ ok: false, reason: 'immutable' });
  });

  it.each(['sent', 'failed'] as const)('refuses to edit a %s campaign', async (status) => {
    const campaign = await createCampaign({ listId: list._id });
    await (await campaignsCollection()).updateOne({ _id: campaign._id }, { $set: { status } });

    expect(await updateCampaignDraft({ campaignId: campaign._id, subject: 'x' })).toEqual({
      ok: false,
      reason: 'immutable',
    });
  });

  it('reports a missing campaign', async () => {
    expect(await updateCampaignDraft({ campaignId: new ObjectId(), subject: 'x' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('version history', () => {
  it('snapshots the previous state on each save', async () => {
    const campaign = await createCampaign({ listId: list._id, subject: 'v1' });
    await updateCampaignDraft({ campaignId: campaign._id, subject: 'v2' });
    await updateCampaignDraft({ campaignId: campaign._id, subject: 'v3' });

    const versions = await listCampaignVersions(campaign._id);
    // Newest first: the states the writer can return to are v2 and v1.
    expect(versions.map((v) => v.subject)).toEqual(['v2', 'v1']);
  });

  it('retains at least the last twenty saves', async () => {
    const campaign = await createCampaign({ listId: list._id, subject: 's0' });
    for (let i = 1; i <= 30; i += 1) {
      await updateCampaignDraft({
        campaignId: campaign._id,
        subject: `s${i}`,
        now: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const versions = await listCampaignVersions(campaign._id, 20);
    expect(versions.length).toBe(20);
  });

  it('restores a previous version and keeps the current one recoverable', async () => {
    const campaign = await createCampaign({ listId: list._id, subject: 'original' });
    await updateCampaignDraft({
      campaignId: campaign._id,
      subject: 'replacement',
      bodySource: doc('new body'),
    });

    const [previous] = await listCampaignVersions(campaign._id);
    expect(await restoreCampaignVersion(campaign._id, previous._id)).toBe(true);

    const restored = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(restored?.subject).toBe('original');

    // Restoring is itself a save, so the replaced state is still recoverable.
    const versions = await listCampaignVersions(campaign._id);
    expect(versions.some((v) => v.subject === 'replacement')).toBe(true);
  });

  it('will not restore a version belonging to another campaign', async () => {
    const a = await createCampaign({ listId: list._id, subject: 'a' });
    const b = await createCampaign({ listId: list._id, subject: 'b' });
    await updateCampaignDraft({ campaignId: a._id, subject: 'a2' });
    const [versionOfA] = await listCampaignVersions(a._id);

    expect(await restoreCampaignVersion(b._id, versionOfA._id)).toBe(false);
  });
});

describe('scheduling', () => {
  it('schedules a draft for a future time', async () => {
    const campaign = await createCampaign({ listId: list._id });
    const when = new Date(Date.now() + 3600_000);

    expect(await scheduleCampaign(campaign._id, when)).toEqual({ ok: true });
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('scheduled');
    expect(doc?.scheduledFor).toEqual(when);
  });

  it('refuses a time in the past', async () => {
    const campaign = await createCampaign({ listId: list._id });
    const result = await scheduleCampaign(campaign._id, new Date(Date.now() - 1000));
    expect(result).toEqual({ ok: false, reason: 'in_the_past' });
  });

  it('refuses an invalid date', async () => {
    const campaign = await createCampaign({ listId: list._id });
    expect(await scheduleCampaign(campaign._id, new Date('nonsense'))).toEqual({
      ok: false,
      reason: 'invalid_date',
    });
  });

  it('refuses to schedule a campaign that is already sending', async () => {
    const campaign = await createCampaign({ listId: list._id });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );

    expect(await scheduleCampaign(campaign._id, new Date(Date.now() + 3600_000))).toEqual({
      ok: false,
      reason: 'wrong_status',
    });
  });

  it('returns a scheduled campaign to draft', async () => {
    const campaign = await createCampaign({ listId: list._id });
    await scheduleCampaign(campaign._id, new Date(Date.now() + 3600_000));

    expect(await unscheduleCampaign(campaign._id)).toBe(true);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
    expect(doc?.scheduledFor).toBeUndefined();
  });
});

describe('pause and resume', () => {
  it('pauses a sending campaign with a reason', async () => {
    const campaign = await createCampaign({ listId: list._id });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );

    expect(await pauseCampaign(campaign._id, 'Bad subject line')).toBe(true);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('paused');
    expect(doc?.pausedReason).toBe('Bad subject line');
  });

  it('will not pause a campaign that is not sending', async () => {
    const campaign = await createCampaign({ listId: list._id });
    expect(await pauseCampaign(campaign._id)).toBe(false);
  });

  it('resumes a paused campaign and clears the pause reason', async () => {
    const campaign = await createCampaign({ listId: list._id });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'paused', pausedReason: 'oops' } },
    );

    expect(await resumeCampaign(campaign._id)).toBe(true);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sending');
    expect(doc?.pausedReason).toBeUndefined();
  });

  it('will not resume a campaign that was never paused', async () => {
    const campaign = await createCampaign({ listId: list._id });
    expect(await resumeCampaign(campaign._id)).toBe(false);
  });
});

describe('test sends', () => {
  async function readyCampaign() {
    const campaign = await createCampaign({ listId: list._id, subject: 'Test subject' });
    await updateCampaignDraft({ campaignId: campaign._id, bodySource: validCampaignDoc() });
    return campaign;
  }

  it('sends through the real render path', async () => {
    // §6.5: a test send must exercise the real render path — same code, same
    // merge, same headers — or it is not a test.
    await createSubscriber(list._id, {
      email: 'real@example.com',
      attributes: { first_name: 'Ada' },
    });
    const campaign = await readyCampaign();

    const result = await sendTestEmail({ campaignId: campaign._id, to: ['me@example.com'] });

    expect(result).toEqual({ ok: true, sent: 1 });
    expect(ses.simpleSends).toHaveLength(1);
    const sent = ses.simpleSends[0];
    expect(sent.to).toBe('me@example.com');
    expect(sent.content.html).toContain('<html');
    expect(sent.content.text.length).toBeGreaterThan(0);
    // Merge data from a real subscriber, so fallbacks get exercised.
    expect(sent.content.html).toContain('Ada');
    expect(sent.content.html).not.toContain('{{');
  });

  it('marks the message as a test so it is obvious in an inbox', async () => {
    const campaign = await readyCampaign();
    await sendTestEmail({ campaignId: campaign._id, to: ['me@example.com'] });

    expect(ses.simpleSends[0].content.subject).toMatch(/^\[TEST\]/);
    expect(ses.simpleSends[0].headers?.['X-SM-Test-Send']).toBe('true');
  });

  it('never touches campaign counts, sent_log or batches', async () => {
    // §6.5: test sends are tagged and excluded from all campaign counts and
    // metrics.
    const campaign = await readyCampaign();
    await sendTestEmail({ campaignId: campaign._id, to: ['a@example.com', 'b@example.com'] });

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.counts.sent).toBe(0);
    expect(doc?.counts.recipients).toBe(0);
    expect(await (await sentLogCollection()).countDocuments()).toBe(0);
  });

  it('still carries a working unsubscribe header', async () => {
    const campaign = await readyCampaign();
    await sendTestEmail({ campaignId: campaign._id, to: ['me@example.com'] });

    expect(ses.simpleSends[0].headers?.['List-Unsubscribe']).toContain('/api/unsubscribe?t=');
  });

  it('refuses an empty or oversized recipient list', async () => {
    const campaign = await readyCampaign();

    expect(await sendTestEmail({ campaignId: campaign._id, to: [] })).toEqual({
      ok: false,
      reason: 'no_recipients',
    });
    expect(
      await sendTestEmail({
        campaignId: campaign._id,
        to: Array.from({ length: 11 }, (_, i) => `x${i}@example.com`),
      }),
    ).toEqual({ ok: false, reason: 'too_many_recipients' });
  });

  it('reports failure when SES rejects every address', async () => {
    const campaign = await readyCampaign();
    ses.failAddresses.add('me@example.com');

    expect(await sendTestEmail({ campaignId: campaign._id, to: ['me@example.com'] })).toEqual({
      ok: false,
      reason: 'send_failed',
    });
  });

  it('reports a missing campaign', async () => {
    expect(await sendTestEmail({ campaignId: new ObjectId(), to: ['a@example.com'] })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
