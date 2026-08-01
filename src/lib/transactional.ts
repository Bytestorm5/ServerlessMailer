import { env } from './env';
import { getMailer } from './mailer';
import { escapeHtml } from './render/tiptap-to-mjml';
import type { ListDoc } from './types';

/**
 * Transactional email (§5.4).
 *
 * Plain, short, and obviously transactional. One call to action, no images, no
 * tracking, no marketing. Its deliverability requirements are different from a
 * newsletter's and its job is singular, so it deliberately shares nothing with
 * the campaign renderer beyond the SES client.
 *
 * This path never goes through the campaign cron (§5.1).
 */

export function confirmationUrl(token: string): string {
  return `${env.appBaseUrl}/api/confirm?token=${encodeURIComponent(token)}`;
}

export function buildConfirmationEmail(list: ListDoc, token: string): { subject: string; html: string; text: string } {
  const url = confirmationUrl(token);
  const subject = `Confirm your subscription to ${list.name}`;

  const text = [
    `Please confirm your subscription to ${list.name}.`,
    '',
    'Click the link below to confirm. If you did not request this, ignore this',
    'email and nothing further will happen.',
    '',
    url,
    '',
    'This link expires in 7 days.',
    '',
    '--',
    list.physicalAddress,
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f242c;">
    <div style="max-width:520px;margin:0 auto;">
      <p style="margin:0 0 16px 0;">Please confirm your subscription to <strong>${escapeHtml(list.name)}</strong>.</p>
      <p style="margin:0 0 24px 0;">
        <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#1f242c;color:#ffffff;text-decoration:none;border-radius:4px;">Confirm subscription</a>
      </p>
      <p style="margin:0 0 16px 0;color:#515d71;font-size:14px;">
        If the button does not work, paste this address into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(url)}</span>
      </p>
      <p style="margin:0 0 16px 0;color:#515d71;font-size:14px;">
        If you did not request this, ignore this email and nothing further will happen.
        This link expires in 7 days.
      </p>
      <hr style="border:0;border-top:1px solid #e2e6ec;margin:24px 0;" />
      <p style="margin:0;color:#66748a;font-size:12px;">${escapeHtml(list.physicalAddress)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}

export async function sendConfirmationEmail(
  list: ListDoc,
  email: string,
  token: string,
): Promise<{ messageId: string | null }> {
  const { subject, html, text } = buildConfirmationEmail(list, token);
  return getMailer().sendTransactional({
    to: email,
    fromName: list.fromName,
    fromEmail: list.fromEmail,
    replyTo: list.replyTo,
    subject,
    html,
    text,
    configurationSet: list.sesConfigurationSet || undefined,
    tags: { type: 'transactional', list_id: String(list._id) },
    headers: {
      // Marks the message as automatic so it does not trigger out-of-office
      // replies, and asks not to be filed as bulk.
      'Auto-Submitted': 'auto-generated',
      Precedence: 'bulk',
    },
  });
}
