import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// Each test *file* gets its own database inside the shared mongod instance so
// that files running in parallel workers cannot see each other's documents.
const dbName = `test_${randomUUID().replace(/-/g, '')}`;

process.env.MONGODB_URI = process.env.__MONGO_URI__ ?? process.env.MONGODB_URI ?? '';
process.env.MONGODB_DB = dbName;

// Deterministic secrets for every test file. Real values come from Vercel env.
process.env.CRON_SECRET = 'test-cron-secret';
process.env.CONFIRM_TOKEN_SECRET = 'test-confirm-secret';
process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
process.env.TRACKING_SECRET = 'test-tracking-secret';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.APP_BASE_URL = 'https://mail.example.com';
process.env.SES_MAX_SEND_RATE = '14';
process.env.MAX_BATCHES_PER_RUN = '10';
process.env.AWS_REGION = 'us-east-1';

// Component test files opt into jsdom with a `@vitest-environment jsdom`
// docblock. Only those files get the DOM matchers and React cleanup, so the
// (much larger) set of node-environment tests stays free of DOM globals.
const isDom = typeof document !== 'undefined';
if (isDom) {
  await import('@testing-library/jest-dom/vitest');

  // jsdom implements no layout, so it has no getClientRects. ProseMirror calls
  // it whenever it scrolls the selection into view, which is on every
  // transaction. Returning an empty rect list is the standard shim: it keeps
  // the editor working headlessly without pretending to know geometry.
  const emptyRect = {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const emptyRectList = Object.assign([] as unknown as DOMRectList, {
    item: () => null,
    length: 0,
  });

  // Same reason: ProseMirror hit-tests on mousedown to map a click to a
  // document position. Without layout there is nothing to hit, so it resolves
  // to null and ProseMirror falls back to its DOM-walking path.
  if (typeof document.elementFromPoint !== 'function') {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });
  }

  for (const proto of [Range.prototype, Element.prototype]) {
    if (typeof (proto as { getClientRects?: unknown }).getClientRects !== 'function') {
      Object.defineProperty(proto, 'getClientRects', {
        configurable: true,
        value: () => emptyRectList,
      });
    }
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      value: () => emptyRect,
    });
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  if (isDom) {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  const { closeMongo, dropTestDatabase } = await import('@/lib/db/client');
  await dropTestDatabase();
  await closeMongo();
});
