import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { processBatch, resetSleeper, setSleeper } from '@/lib/pipeline/process';
import { claimBatch } from '@/lib/pipeline/claim';
import {
  campaignBatchesCollection,
  campaignsCollection,
  emailTemplatesCollection,
  listsCollection,
  sentLogCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { deleteTemplate, saveTemplate } from '@/lib/templates';
import { createCampaign, createList, createSubscriber, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { ListDoc } from '@/lib/types';

/**
 * Freeze and the template (§7.1).
 *
 * "A template change mid-send must not produce two different emails." The
 * rendered body has always been frozen; the template has to be frozen with it,
 * because that is where the merge fields and their fallbacks live and SES
 * substitutes them per recipient, batch by batch, long after freeze.
 */

const TEMPLATE =
  '<html><body><h1>{{list_name}}</h1><p>Hi {{ first_name | default: "there" }}</p>' +
  '{{content}}<p>{{physical_address}}</p><a href="{{unsubscribe_url}}">Out</a></body></html>';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
    (await listsCollection()).deleteMany({}),
    (await emailTemplatesCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
  setSleeper(async () => {});
});

afterEach(() => {
  resetSesAdapter();
  resetSleeper();
});

async function freeze() {
  await createSubscriber(list._id, {
    email: 'reader@example.com',
    attributes: { first_name: 'Ada' },
  });
  const campaign = await createCampaign(list._id, {
    status: 'draft',
    bodySource: validCampaignDoc(),
  });
  const result = await freezeCampaign(campaign._id);
  if (!result.ok) throw new Error(`freeze failed: ${result.reason}`);
  return (await campaignsCollection()).findOne({ _id: campaign._id });
}

describe('freezeCampaign with a template', () => {
  it('renders through the template and stores a copy of it', async () => {
    await saveTemplate(list._id, TEMPLATE);
    const frozen = await freeze();

    expect(frozen?.bodyHtml).toContain('<h1>Domain A Weekly</h1>');
    expect(frozen?.templateSource).toBe(TEMPLATE);
  });

  it('stores no template when the list is on the built-in layout', async () => {
    const frozen = await freeze();

    expect(frozen?.templateSource).toBeUndefined();
    expect(frozen?.bodyHtml).toContain('<html');
  });

  it('clears a stale copy from an earlier freeze', async () => {
    // A campaign rolled back to draft after a template was removed must not
    // keep rendering against the template it no longer has.
    await saveTemplate(list._id, TEMPLATE);
    await createSubscriber(list._id, { email: 'first@example.com' });
    const campaign = await createCampaign(list._id, {
      status: 'draft',
      bodySource: validCampaignDoc(),
      templateSource: TEMPLATE,
    });

    await deleteTemplate(list._id);
    const result = await freezeCampaign(campaign._id);

    expect(result.ok).toBe(true);
    const frozen = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(frozen?.templateSource).toBeUndefined();
  });

  it('substitutes the template’s own merge fields per recipient at send time', async () => {
    await saveTemplate(list._id, TEMPLATE);
    const frozen = await freeze();

    const batch = await claimBatch('test-run');
    expect(batch).not.toBeNull();
    await processBatch(batch!);

    const sent = ses.bulkSends.at(-1)!.params;
    expect(sent.destinations[0].replacements.first_name).toBe('Ada');
    expect(sent.content.html).toBe(frozen?.bodyHtml);
  });

  it('keeps substituting the frozen template after the live one changes', async () => {
    await saveTemplate(list._id, TEMPLATE);
    await freeze();

    // The operator edits the template while the send is in flight.
    await saveTemplate(
      list._id,
      TEMPLATE.replace('{{ first_name | default: "there" }}', '{{ company | default: "your team" }}'),
    );

    const batch = await claimBatch('test-run');
    await processBatch(batch!);

    const sent = ses.bulkSends.at(-1)!.params;
    expect(sent.destinations[0].replacements.first_name).toBe('Ada');
    expect(sent.destinations[0].replacements.company).toBeUndefined();
  });
});
