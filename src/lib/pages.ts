/**
 * Minimal server-rendered pages for the public, unauthenticated flows
 * (confirmation and unsubscribe).
 *
 * These are deliberately plain HTML strings rather than React pages: they must
 * render even if the app bundle is broken, because §9 makes unsubscribe the most
 * availability-critical endpoint in the system — if it fails during a send,
 * complaints accrue against the SES thresholds in §8.3.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PublicPageOptions {
  title: string;
  heading: string;
  /** Already-escaped HTML fragments, in order. */
  bodyHtml: string;
  status?: number;
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem 1.25rem;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fbfbfa; color: #1c1c1a;
  }
  main { max-width: 32rem; width: 100%; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.75rem; letter-spacing: -0.01em; }
  p { margin: 0 0 1rem; color: #45443f; }
  form { margin: 1.5rem 0 0; }
  button {
    font: inherit; font-weight: 500; cursor: pointer;
    padding: 0.6rem 1.1rem; border-radius: 0.5rem;
    border: 1px solid #d5d3cc; background: #fff; color: #1c1c1a;
  }
  button:hover { background: #f4f3ef; }
  .muted { font-size: 0.875rem; color: #6b6963; }
  a { color: #1c1c1a; }
  @media (prefers-color-scheme: dark) {
    body { background: #17171a; color: #ececea; }
    p { color: #b4b2ac; }
    button { background: #232326; border-color: #3a3a3e; color: #ececea; }
    button:hover { background: #2c2c30; }
    .muted { color: #8d8b85; }
    a { color: #ececea; }
  }
`;

export function renderPublicPage(options: PublicPageOptions): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.heading)}</h1>
${options.bodyHtml}
</main>
</body>
</html>`;

  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // These pages reflect per-recipient state and must never be cached by an
      // intermediary and served to somebody else.
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
    },
  });
}

export { escapeHtml };
