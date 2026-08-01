import type {
  BulkResultEntry,
  SendBulkParams,
  SendSimpleParams,
  SesAdapter,
} from '@/lib/ses/types';
import { SesThrottlingError } from '@/lib/ses/types';

export interface RecordedBulkSend {
  params: SendBulkParams;
  results: BulkResultEntry[];
}

/**
 * In-memory SES. Records everything, and can be told to fail specific
 * addresses, throttle, or throw mid-call so the pipeline's recovery paths are
 * exercised for real rather than asserted about.
 */
export class FakeSes implements SesAdapter {
  readonly bulkSends: RecordedBulkSend[] = [];
  readonly simpleSends: SendSimpleParams[] = [];
  readonly verifiedIdentities = new Set<string>();

  /** Addresses that come back as per-destination failures. */
  failAddresses = new Set<string>();
  /** When > 0, the next N sendBulk calls throw a throttling error. */
  throttleNextCalls = 0;
  /** When set, sendBulk throws this before recording anything (crash sim). */
  throwOnNextBulk: Error | undefined;
  /** Invoked before each sendBulk; lets a test mutate the DB mid-send. */
  onBeforeBulk: ((params: SendBulkParams) => void | Promise<void>) | undefined;

  private messageCounter = 0;

  async sendBulk(params: SendBulkParams): Promise<BulkResultEntry[]> {
    if (this.onBeforeBulk) await this.onBeforeBulk(params);
    if (this.throttleNextCalls > 0) {
      this.throttleNextCalls -= 1;
      throw new SesThrottlingError('Maximum sending rate exceeded');
    }
    if (this.throwOnNextBulk) {
      const err = this.throwOnNextBulk;
      this.throwOnNextBulk = undefined;
      throw err;
    }
    const results: BulkResultEntry[] = params.destinations.map((destination) => {
      if (this.failAddresses.has(destination.email)) {
        return {
          email: destination.email,
          status: 'failed' as const,
          error: 'MessageRejected',
        };
      }
      this.messageCounter += 1;
      return {
        email: destination.email,
        status: 'success' as const,
        messageId: `msg-${this.messageCounter}`,
      };
    });
    this.bulkSends.push({ params, results });
    return results;
  }

  async sendSimple(params: SendSimpleParams): Promise<{ messageId: string }> {
    if (this.failAddresses.has(params.to)) {
      throw new Error('MessageRejected');
    }
    this.simpleSends.push(params);
    this.messageCounter += 1;
    return { messageId: `msg-${this.messageCounter}` };
  }

  async isIdentityVerified(domainOrEmail: string): Promise<boolean> {
    const domain = domainOrEmail.includes('@')
      ? domainOrEmail.split('@')[1]
      : domainOrEmail;
    return this.verifiedIdentities.has(domain) || this.verifiedIdentities.has(domainOrEmail);
  }

  /** Every address that received a message, across all bulk sends. */
  allSentAddresses(): string[] {
    return this.bulkSends.flatMap((send) =>
      send.results.filter((r) => r.status === 'success').map((r) => r.email),
    );
  }

  reset(): void {
    this.bulkSends.length = 0;
    this.simpleSends.length = 0;
    this.failAddresses.clear();
    this.throttleNextCalls = 0;
    this.throwOnNextBulk = undefined;
    this.onBeforeBulk = undefined;
  }
}
