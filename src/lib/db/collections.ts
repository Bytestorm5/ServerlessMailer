import type { Collection } from 'mongodb';
import { getDb } from '@/lib/db/client';
import type {
  CampaignBatchDoc,
  CampaignDoc,
  CampaignVersionDoc,
  EventDoc,
  ImportAttestationDoc,
  ListDoc,
  RateLimitDoc,
  SeedAddressDoc,
  SentLogDoc,
  SubscriberDoc,
  SuppressionDoc,
} from '@/lib/types';

export const COLLECTION_NAMES = {
  lists: 'lists',
  subscribers: 'subscribers',
  suppressions: 'suppressions',
  campaigns: 'campaigns',
  campaignBatches: 'campaign_batches',
  sentLog: 'sent_log',
  events: 'events',
  campaignVersions: 'campaign_versions',
  rateLimits: 'rate_limits',
  seedAddresses: 'seed_addresses',
  importAttestations: 'import_attestations',
} as const;

export async function listsCollection(): Promise<Collection<ListDoc>> {
  return (await getDb()).collection<ListDoc>(COLLECTION_NAMES.lists);
}

export async function subscribersCollection(): Promise<Collection<SubscriberDoc>> {
  return (await getDb()).collection<SubscriberDoc>(COLLECTION_NAMES.subscribers);
}

export async function suppressionsCollection(): Promise<Collection<SuppressionDoc>> {
  return (await getDb()).collection<SuppressionDoc>(COLLECTION_NAMES.suppressions);
}

export async function campaignsCollection(): Promise<Collection<CampaignDoc>> {
  return (await getDb()).collection<CampaignDoc>(COLLECTION_NAMES.campaigns);
}

export async function campaignBatchesCollection(): Promise<Collection<CampaignBatchDoc>> {
  return (await getDb()).collection<CampaignBatchDoc>(COLLECTION_NAMES.campaignBatches);
}

export async function sentLogCollection(): Promise<Collection<SentLogDoc>> {
  return (await getDb()).collection<SentLogDoc>(COLLECTION_NAMES.sentLog);
}

export async function eventsCollection(): Promise<Collection<EventDoc>> {
  return (await getDb()).collection<EventDoc>(COLLECTION_NAMES.events);
}

export async function campaignVersionsCollection(): Promise<Collection<CampaignVersionDoc>> {
  return (await getDb()).collection<CampaignVersionDoc>(COLLECTION_NAMES.campaignVersions);
}

export async function rateLimitsCollection(): Promise<Collection<RateLimitDoc>> {
  return (await getDb()).collection<RateLimitDoc>(COLLECTION_NAMES.rateLimits);
}

export async function seedAddressesCollection(): Promise<Collection<SeedAddressDoc>> {
  return (await getDb()).collection<SeedAddressDoc>(COLLECTION_NAMES.seedAddresses);
}

export async function importAttestationsCollection(): Promise<
  Collection<ImportAttestationDoc>
> {
  return (await getDb()).collection<ImportAttestationDoc>(
    COLLECTION_NAMES.importAttestations,
  );
}
