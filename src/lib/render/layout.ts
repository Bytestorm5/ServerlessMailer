import { escapeHtml } from './tiptap-to-mjml';

/**
 * The campaign email shell.
 *
 * Hand-authoring table-based email HTML is a solved problem not worth
 * re-solving (§6.2) — MJML compiles this to the nested tables Outlook's Word
 * rendering engine needs and inlines the CSS on the way out.
 *
 * The footer is not decoration. The physical postal address and the
 * unsubscribe link are legally required in every campaign, and the pre-send
 * gate asserts they survived into the rendered output.
 */

export interface LayoutOptions {
  bodyMjml: string;
  /** Already compiled and escaped by the caller — merge fields are permitted. */
  preheaderHtml: string;
  listName: string;
  physicalAddress: string;
  /** Rendered as the `{{unsubscribe_url}}` placeholder in a real send. */
  unsubscribeUrl: string;
  preferencesUrl: string;
}

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function buildCampaignMjml(options: LayoutOptions): string {
  const { bodyMjml, preheaderHtml, listName, physicalAddress, unsubscribeUrl, preferencesUrl } = options;

  return `<mjml>
  <mj-head>
    ${preheaderHtml.trim() ? `<mj-preview>${preheaderHtml}</mj-preview>` : ''}
    <mj-attributes>
      <mj-all font-family="${FONT_STACK}" />
      <mj-text font-size="16px" line-height="1.6" color="#1f242c" />
      <mj-section padding="0" />
    </mj-attributes>
    <mj-style inline="inline">
      a { color: #1a5fb4; }
      blockquote { border-left: 3px solid #d5dae1; }
    </mj-style>
    <mj-style>
      @media only screen and (max-width: 480px) {
        .body-pad { padding-left: 18px !important; padding-right: 18px !important; }
      }
    </mj-style>
  </mj-head>
  <mj-body background-color="#f2f4f7" width="640px">
    <mj-section background-color="#f2f4f7" padding="20px 0 8px 0">
      <mj-column>
        <mj-text align="center" font-size="12px" color="#66748a" letter-spacing="0.04em" text-transform="uppercase">
          ${escapeHtml(listName)}
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="34px 0 26px 0" border-radius="6px" css-class="body-pad">
      <mj-column padding="0 34px">
${bodyMjml}
      </mj-column>
    </mj-section>

    <mj-section background-color="#f2f4f7" padding="22px 0 34px 0">
      <mj-column padding="0 26px">
        <mj-text align="center" font-size="12px" line-height="1.7" color="#66748a">
          ${escapeHtml(physicalAddress)}
        </mj-text>
        <mj-text align="center" font-size="12px" line-height="1.7" color="#66748a">
          <a href="${unsubscribeUrl}" style="color:#66748a;text-decoration:underline;">Unsubscribe</a>
          &nbsp;&middot;&nbsp;
          <a href="${preferencesUrl}" style="color:#66748a;text-decoration:underline;">Email preferences</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

export function buildFooterText(options: {
  physicalAddress: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}): string {
  return [
    '',
    '--',
    options.physicalAddress,
    '',
    `Unsubscribe: ${options.unsubscribeUrl}`,
    `Email preferences: ${options.preferencesUrl}`,
  ].join('\n');
}
