import { ObjectId } from 'mongodb';
import { requireAdmin } from '@/lib/auth';
import { logger } from '@/lib/logging';

/**
 * Admin route guard (spec §12).
 *
 * There are no public write paths to campaigns or subscribers, so every admin
 * handler goes through this. It returns 401 before the handler runs, and turns
 * an unexpected throw into a 500 that carries no internal detail.
 */
export type AdminHandler<C = unknown> = (
  request: Request,
  ctx: C,
) => Promise<Response>;

export function withAdmin<C>(handler: AdminHandler<C>): AdminHandler<C> {
  return async (request, ctx) => {
    try {
      // Inside the try on purpose: if session verification itself throws — a
      // missing secret, a malformed cookie header — the safe answer is a 401,
      // not an unhandled rejection that Next turns into an opaque crash.
      const session = await requireAdmin(request);
      if (!session) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      return await handler(request, ctx);
    } catch (err) {
      // Not `(err as Error).message`: a handler that rejects with a bare null
      // would make the dereference throw *inside* the catch, so withAdmin would
      // escape without returning the 500 this block exists to guarantee.
      logger.error('admin route failed', {
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ ok: false, error: 'internal error' }, { status: 500 });
    }
  };
}

export function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export function notFound(message = 'not found'): Response {
  return Response.json({ ok: false, error: message }, { status: 404 });
}

/** Parses a path parameter into an ObjectId, or null when it is not one. */
export function toObjectId(value: string | undefined): ObjectId | null {
  return value && ObjectId.isValid(value) ? new ObjectId(value) : null;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
