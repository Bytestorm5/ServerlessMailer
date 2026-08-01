import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type output } from 'zod';
import { UnauthorizedError } from './auth';
import { errorMessage, log } from './logger';
import { env } from './env';

/** Shared response helpers for route handlers. */

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function badRequest(message: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status: 400 });
}

export function notFound(message = 'Not found'): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Wraps a handler so an unexpected throw becomes a 500 with a logged, redacted
 * message rather than a stack trace in the response body.
 */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorized();
    if (error instanceof ZodError) {
      return badRequest('Invalid request', { issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    log.error('unhandled route error', { error: errorMessage(error) });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/**
 * Parses and validates a JSON body.
 *
 * Generic over the schema rather than over a result type, so a schema using
 * `.default()` returns its *output* type — `string[]`, not `string[] |
 * undefined` — and callers do not have to re-assert what the schema already
 * guarantees.
 */
export async function parseJson<S extends ZodTypeAny>(request: Request, schema: S): Promise<output<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ZodError([{ code: 'custom', path: [], message: 'Body must be valid JSON' }]);
  }
  return schema.parse(body) as output<S>;
}

/**
 * Cron authentication (§12): verify `Authorization: Bearer ${CRON_SECRET}`
 * before any work. Vercel sends this automatically on cron invocations.
 */
export function verifyCronRequest(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  // Constant-time comparison over the raw bytes.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function invocationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
