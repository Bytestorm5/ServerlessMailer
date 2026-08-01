import { ObjectId } from 'mongodb';
import { collections } from './db';
import { getMailer } from './mailer';
import { resolveMergePlanFromSample, subscriberFieldValue } from './merge';
import { renderStoredCampaign } from './render/render-campaign';
import { OPEN_PIXEL_VARIABLE, clickVariable, openPixelUrl, signClickToken, signOpenToken } from './tracking';
import { preferencesUrl, signUnsubscribeToken, unsubscribeMailto, unsubscribeUrl } from './unsubscribe';
import { availableMergeFields } from './validation';
import { env } from './env';
import type { CampaignDoc, ListDoc, SubscriberDoc } from './types';

/**
 * Test sends (§6.5).
 *
 * A test send must exercise the real render path — same code, same merge, same
 * headers — or it is not a test. The only differences are the recipient list
 * and the `type: test` tag, which keeps these messages out of every campaign
 * count and metric.
 *
 * The unsubscribe token is signed for a throwaway subscriber id, so clicking
 * the footer link in a test proves the link works without unsubscribing the
 * person whose merge data was borrowed for the preview.
 */

export interface TestSendResult {
  sent: number;
  failed: number;
  errors: string[];
}

export async function sendTestCampaign(input: {
  campaign: CampaignDoc;
  list: ListDoc;
  recipients: string[];
  sampleSubscriber?: SubscriberDoc | null;
  sentBy: string;
}): Promise<TestSendResult> {
  const { campaign, list, recipients, sampleSubscriber, sentBy } = input;
  const c = await collections();

  const rendered = renderStoredCampaign(campaign, list);
  const sample = buildSampleData(list, sampleSubscriber ?? null);
  const throwawayId = new ObjectId();
  const token = signUnsubscribeToken(throwawayId, campaign._id);

  const data: Record<string, string> = {
    ...resolveMergePlanFromSample(rendered.mergePlan, sample),
    unsubscribe_url: unsubscribeUrl(token),
    preferences_url: preferencesUrl(token),
    physical_address: list.physicalAddress,
    list_name: list.name,
    from_name: list.fromName,
    subject: campaign.subject,
  };

  if (campaign.trackOpens) {
    data[OPEN_PIXEL_VARIABLE] = openPixelUrl(signOpenToken(campaign._id, throwawayId));
  }
  if (campaign.trackClicks) {
    rendered.trackedLinks.forEach((target, index) => {
      data[clickVariable(index)] =
        `${env.appBaseUrl}/api/t/c/${signClickToken(campaign._id, throwawayId, target)}`;
    });
  }

  const response = await getMailer().sendBulk({
    fromName: list.fromName,
    fromEmail: list.fromEmail,
    replyTo: list.replyTo,
    configurationSet: list.sesConfigurationSet || undefined,
    subjectTemplate: `[TEST] ${rendered.subjectTemplate}`,
    htmlTemplate: rendered.html,
    textTemplate: rendered.text,
    defaultData: data,
    destinations: recipients.map((to) => ({
      to,
      replacementData: data,
      headers: {
        'List-Unsubscribe': `<mailto:${unsubscribeMailto(list.sendingDomain)}>, <${unsubscribeUrl(token)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: { campaign_id: String(campaign._id), list_id: String(list._id), type: 'test' },
    })),
    tags: { campaign_id: String(campaign._id), list_id: String(list._id), type: 'test' },
  });

  const result: TestSendResult = { sent: 0, failed: 0, errors: [] };
  for (const outcome of response.outcomes) {
    if (outcome.ok) result.sent += 1;
    else {
      result.failed += 1;
      if (result.errors.length < 5) result.errors.push(outcome.error);
    }
  }

  await c.testSends.insertOne({
    campaignId: campaign._id,
    recipients,
    sentAt: new Date(),
    sentBy,
  } as never);

  return result;
}

/** Merge values for previews and tests, from a real subscriber when available. */
export function buildSampleData(list: ListDoc, subscriber: SubscriberDoc | null): Record<string, string> {
  const sample: Record<string, string> = {};
  if (!subscriber) return sample;
  for (const field of availableMergeFields(list)) {
    const value = subscriberFieldValue(subscriber, field);
    if (value !== undefined) sample[field] = value;
  }
  return sample;
}
