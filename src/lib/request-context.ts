/**
 * Client attribution helpers.
 *
 * The IP and user agent captured here become permanent consent evidence
 * (spec §5.3), so they are read from the proxy headers Vercel sets rather than
 * from anything the browser can trivially choose.
 */

/**
 * The client IP. `x-forwarded-for` is a comma-separated chain appended to by
 * each proxy, so the client is the first entry.
 */
export function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip')?.trim();
  return real || undefined;
}

export function userAgent(request: Request): string | undefined {
  // Bounded: this is stored forever, and an unbounded header is a cheap way to
  // bloat every subscriber document.
  return request.headers.get('user-agent')?.slice(0, 512) || undefined;
}
