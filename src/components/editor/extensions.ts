import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import type { Extensions } from '@tiptap/react';

/**
 * The editor's node set is deliberately closed (spec §6.1): headings,
 * bold/italic, links, lists, blockquotes, images and horizontal rules. "That is
 * the complete list. Resist additions."
 *
 * StarterKit ships more than that, so the extras are switched off explicitly
 * here rather than merely left off the toolbar — otherwise a markdown shortcut
 * or a paste would still produce a node the email renderer has no template for,
 * and the server-side document validator would then reject the campaign.
 */
export function newsletterExtensions(placeholder?: string): Extensions {
  return [
    StarterKit.configure({
      // Not in the allowed set. Email clients render <code> inconsistently and
      // a code block in a newsletter is almost always an accident.
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,

      heading: { levels: [2, 3] },

      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        // Belt and braces with the toolbar's own check and the server-side
        // document validator.
        protocols: ['http', 'https'],
      },
    }),

    Image.configure({
      inline: false,
      allowBase64: false,
    }),

    Placeholder.configure({
      placeholder: placeholder ?? 'Write something worth reading…',
    }),
  ];
}

/**
 * Shared URL guard for the link and image controls.
 *
 * Only absolute http(s) URLs are accepted: a relative URL silently breaks in
 * every email client, and a `javascript:` URL is an XSS vector in webmail.
 */
export function isSafeAbsoluteUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Credentials in a URL display as one host and resolve to another.
  if (url.username || url.password) return false;
  return Boolean(url.hostname);
}
