import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { reputationSnapshot, REPUTATION_THRESHOLDS } from '@/lib/stats';
import { campaignsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList, emptyCounts } from '@tests/helpers/factories';
import type { CampaignCounts, ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await (await campaignsCollection()).deleteMany({});
  list = await createList();
});

async function sentCampaign(counts: Partial<CampaignCounts>, completedAt: Date) {
  return createCampaign(list._id, {
    status: 'sent',
    completedAt,
    counts: { ...emptyCounts(), ...counts },
  });
}

const NOW = new Date('2026-08-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('reputationSnapshot', () => {
  it('aggregates rates across the rolling window', async () => {
    await sentCampaign({ sent: 10_000, delivered: 9_900, bounced: 100, complained: 5 }, daysAgo(3));
    await sentCampaign({ sent: 10_000, delivered: 9_900, bounced: 100, complained: 5 }, daysAgo(10));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.sent).toBe(20_000);
    expect(snapshot.bounced).toBe(200);
    expect(snapshot.complained).toBe(10);
    // Rates are against messages sent, as SES computes them.
    expect(snapshot.bounceRate).toBeCloseTo(0.01, 6);
    expect(snapshot.complaintRate).toBeCloseTo(0.0005, 6);
  });

  it('excludes campaigns outside the window', async () => {
    await sentCampaign({ delivered: 1000, bounced: 10 }, daysAgo(5));
    await sentCampaign({ delivered: 9999, bounced: 9999 }, daysAgo(90));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.delivered).toBe(1000);
    expect(snapshot.bounced).toBe(10);
  });

  it('reports zero rates rather than NaN when nothing has been delivered', async () => {
    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.delivered).toBe(0);
    expect(snapshot.bounceRate).toBe(0);
    expect(snapshot.complaintRate).toBe(0);
    expect(Number.isNaN(snapshot.bounceRate)).toBe(false);
  });

  it('is healthy at low rates', async () => {
    await sentCampaign({ sent: 10_000, delivered: 9_900, bounced: 100, complained: 5 }, daysAgo(1));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.bounceStatus).toBe('ok');
    expect(snapshot.complaintStatus).toBe('ok');
  });

  it('flags a bounce rate above the SES review threshold', async () => {
    // §8.3: above 5% the account is under review; above 10% sending is paused.
    await sentCampaign({ sent: 10_000, delivered: 9_400, bounced: 600 }, daysAgo(1));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.bounceRate).toBeCloseTo(0.06, 6);
    expect(snapshot.bounceStatus).toBe('at_risk');
  });

  it('flags a bounce rate above the SES suspension threshold', async () => {
    await sentCampaign({ sent: 10_000, delivered: 8_800, bounced: 1200 }, daysAgo(1));

    expect((await reputationSnapshot({ days: 30, now: NOW })).bounceStatus).toBe('critical');
  });

  it('flags a complaint rate above the SES review threshold', async () => {
    // §8.3: above 0.1% under review; above 0.5% sending paused.
    await sentCampaign({ sent: 10_000, delivered: 10_000, complained: 20 }, daysAgo(1));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.complaintRate).toBeCloseTo(0.002, 6);
    expect(snapshot.complaintStatus).toBe('at_risk');
  });

  it('flags a complaint rate above the SES suspension threshold', async () => {
    await sentCampaign({ sent: 10_000, delivered: 10_000, complained: 60 }, daysAgo(1));

    expect((await reputationSnapshot({ days: 30, now: NOW })).complaintStatus).toBe('critical');
  });

  it('includes an actively sending campaign, since that is when it matters', async () => {
    // The rates that matter are the live ones — a campaign going out right now
    // is exactly what the operator needs to watch.
    await createCampaign(list._id, {
      status: 'sending',
      startedAt: daysAgo(0),
      counts: { ...emptyCounts(), delivered: 5000, bounced: 400 },
    });

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });
    expect(snapshot.delivered).toBe(5000);
    expect(snapshot.bounceStatus).toBe('at_risk');
  });

  it('ignores drafts, which have sent nothing', async () => {
    await createCampaign(list._id, {
      status: 'draft',
      counts: { ...emptyCounts(), delivered: 9999, bounced: 9999 },
    });

    expect((await reputationSnapshot({ days: 30, now: NOW })).delivered).toBe(0);
  });

  it('can be scoped to a single list', async () => {
    const other = await createList({ name: 'Domain B' });
    await sentCampaign({ delivered: 1000, bounced: 10 }, daysAgo(1));
    await createCampaign(other._id, {
      status: 'sent',
      completedAt: daysAgo(1),
      counts: { ...emptyCounts(), delivered: 5000, bounced: 500 },
    });

    const scoped = await reputationSnapshot({ days: 30, now: NOW, listId: list._id });
    expect(scoped.delivered).toBe(1000);
  });
});

describe('reputationSnapshot — without delivery events', () => {
  it('still reports a real bounce rate when Delivery notifications are not subscribed', async () => {
    // Delivery events are an optional SNS subscription (section 8.2). A rate
    // computed against `delivered` would read 0% here, which is the most
    // dangerous possible reading.
    await sentCampaign({ sent: 10_000, delivered: 0, bounced: 900 }, daysAgo(1));

    const snapshot = await reputationSnapshot({ days: 30, now: NOW });

    expect(snapshot.bounceRate).toBeCloseTo(0.09, 6);
    expect(snapshot.bounceStatus).toBe('at_risk');
  });
});

describe('REPUTATION_THRESHOLDS', () => {
  it('matches the SES account-level thresholds in the spec', async () => {
    expect(REPUTATION_THRESHOLDS.bounce).toEqual({ atRisk: 0.05, critical: 0.1 });
    expect(REPUTATION_THRESHOLDS.complaint).toEqual({ atRisk: 0.001, critical: 0.005 });
  });
});
