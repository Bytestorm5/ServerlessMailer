import { config } from '@/lib/config';
import { escapeHtml } from '@/lib/pages';
import type { EmailContent } from '@/lib/ses/types';
import type { ListDoc } from '@/lib/types';

/**
 * The double opt-in confirmation email (spec §5.4).
 *
 * Plain, short, and obviously transactional. One clear call to action, no
 * marketing content, no images, no tracking. It deliberately looks nothing like
 * a newsletter, because its deliverability requirements are different and its
 * job is singular: get one link clicked.
 *
 * This is sent immediately via SES on signup — it does **not** go through the
 * campaign cron (§5.1 step 7).
 */

export function confirmationUrl(token: string): string {
  return `${config.appBaseUrl()}/api/confirm?token=${encodeURIComponent(token)}`;
}

export function buildConfirmationEmail(list: ListDoc, token: string): EmailContent {
  const url = confirmationUrl(token);
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(list.name);

  const text = [
    `Confirm your subscription to ${list.name}`,
    '',
    'Click the link below to confirm you want to receive these emails:',
    '',
    url,
    '',
    "If you didn't ask to subscribe, ignore this email and nothing will happen.",
    '',
    list.physicalAddress,
  ].join('\n');

  // Intentionally a single anchor: a second link competes with the call to
  // action, and every extra element is another thing a spam filter can dislike.
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Confirm your subscription</title></head>
<body style="margin:0;padding:24px;background:#ffffff;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1c1a;">
<div style="max-width:32rem;margin:0 auto;">
<p style="margin:0 0 1rem;">Please confirm you want to receive <strong>${safeName}</strong>.</p>
<p style="margin:0 0 1.5rem;"><a href="${safeUrl}" style="color:#0b5cff;">Confirm your subscription</a></p>
<p style="margin:0 0 1rem;color:#57564f;font-size:14px;">If you didn&#39;t ask to subscribe, ignore this email and nothing will happen.</p>
<p style="margin:1.5rem 0 0;color:#8a887f;font-size:12px;">${escapeHtml(list.physicalAddress)}</p>
</div>
</body>
</html>`;

  return {
    subject: `Confirm your subscription to ${list.name}`,
    html,
    text,
  };
}
