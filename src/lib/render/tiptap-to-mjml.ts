import { compileMergeFields, MergePlanBuilder } from '../merge';
import type { TiptapDoc, TiptapNode } from '../types';
import { LinkRegistry } from './link-registry';

/**
 * Tiptap JSON → MJML body content.
 *
 * The supported node set is exactly the list in §6.1 — headings, bold/italic,
 * links, lists, blockquotes, images, horizontal rules — and nothing else.
 * Unknown nodes are dropped rather than passed through, so an editor
 * extension added later cannot silently emit unreviewed HTML into 19,000
 * inboxes.
 */

export interface MjmlRenderContext {
  builder: MergePlanBuilder;
  links: LinkRegistry;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(input: string): string {
  return escapeHtml(input);
}

function renderText(node: TiptapNode, ctx: MjmlRenderContext): string {
  const raw = node.text ?? '';
  let html = compileMergeFields(raw, ctx.builder, escapeHtml);

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'link': {
        const placeholder = ctx.links.add(String(mark.attrs?.href ?? ''));
        if (placeholder === null) break;
        html = `<a href="${placeholder}" target="_blank" rel="noopener" style="color:#1a5fb4;text-decoration:underline;">${html}</a>`;
        break;
      }
      default:
        // Unsupported mark: keep the text, drop the formatting.
        break;
    }
  }
  return html;
}

function renderInline(nodes: TiptapNode[] | undefined, ctx: MjmlRenderContext): string {
  if (!nodes) return '';
  return nodes
    .map((node) => {
      if (node.type === 'text') return renderText(node, ctx);
      if (node.type === 'hardBreak') return '<br />';
      // A nested block inside an inline context (shouldn't happen) is flattened.
      return renderInline(node.content, ctx);
    })
    .join('');
}

function renderListItems(node: TiptapNode, ctx: MjmlRenderContext): string {
  return (node.content ?? [])
    .filter((item) => item.type === 'listItem')
    .map((item) => {
      const inner = (item.content ?? [])
        .map((child) => {
          if (child.type === 'paragraph') return renderInline(child.content, ctx);
          if (child.type === 'bulletList')
            return `<ul style="margin:6px 0 0 0;padding-left:22px;">${renderListItems(child, ctx)}</ul>`;
          if (child.type === 'orderedList')
            return `<ol style="margin:6px 0 0 0;padding-left:22px;">${renderListItems(child, ctx)}</ol>`;
          return renderInline(child.content, ctx);
        })
        .join('');
      return `<li style="margin:0 0 6px 0;">${inner}</li>`;
    })
    .join('');
}

const HEADING_STYLES: Record<number, string> = {
  1: 'font-size:30px;line-height:1.25;font-weight:700;margin:0 0 14px 0;',
  2: 'font-size:24px;line-height:1.3;font-weight:700;margin:24px 0 12px 0;',
  3: 'font-size:19px;line-height:1.35;font-weight:700;margin:22px 0 10px 0;',
  4: 'font-size:17px;line-height:1.4;font-weight:700;margin:20px 0 8px 0;',
  5: 'font-size:15px;line-height:1.4;font-weight:700;margin:18px 0 8px 0;',
  6: 'font-size:14px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin:18px 0 8px 0;',
};

function renderBlock(node: TiptapNode, ctx: MjmlRenderContext): string {
  switch (node.type) {
    case 'paragraph': {
      const inner = renderInline(node.content, ctx);
      if (inner.trim() === '') return '<mj-spacer height="12px" />';
      return `<mj-text padding="0 0 16px 0"><p style="margin:0;">${inner}</p></mj-text>`;
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)));
      const style = HEADING_STYLES[level] ?? HEADING_STYLES[2];
      const inner = renderInline(node.content, ctx);
      return `<mj-text padding="0 0 4px 0"><h${level} style="${style}">${inner}</h${level}></mj-text>`;
    }
    case 'bulletList':
      return `<mj-text padding="0 0 16px 0"><ul style="margin:0;padding-left:22px;">${renderListItems(node, ctx)}</ul></mj-text>`;
    case 'orderedList':
      return `<mj-text padding="0 0 16px 0"><ol style="margin:0;padding-left:22px;">${renderListItems(node, ctx)}</ol></mj-text>`;
    case 'blockquote': {
      const inner = (node.content ?? []).map((child) => renderBlockInsideQuote(child, ctx)).join('');
      return `<mj-text padding="0 0 16px 0"><blockquote style="margin:0;padding:2px 0 2px 18px;border-left:3px solid #d5dae1;color:#515d71;font-style:italic;">${inner}</blockquote></mj-text>`;
    }
    case 'horizontalRule':
      return '<mj-divider border-width="1px" border-color="#e2e6ec" padding="12px 0 26px 0" />';
    case 'image': {
      const src = String(node.attrs?.src ?? '');
      if (!LinkRegistry.isAbsoluteHttpUrl(src)) {
        // Recorded through the registry so the gate reports it with the links.
        ctx.links.add(src);
        return '';
      }
      const alt = escapeAttribute(String(node.attrs?.alt ?? ''));
      const title = node.attrs?.title ? ` title="${escapeAttribute(String(node.attrs.title))}"` : '';
      return `<mj-image src="${escapeAttribute(src)}" alt="${alt}"${title} padding="0 0 20px 0" align="center" />`;
    }
    default:
      return '';
  }
}

function renderBlockInsideQuote(node: TiptapNode, ctx: MjmlRenderContext): string {
  if (node.type === 'paragraph') return `<p style="margin:0 0 8px 0;">${renderInline(node.content, ctx)}</p>`;
  if (node.type === 'bulletList') return `<ul style="margin:0;padding-left:22px;">${renderListItems(node, ctx)}</ul>`;
  if (node.type === 'orderedList') return `<ol style="margin:0;padding-left:22px;">${renderListItems(node, ctx)}</ol>`;
  return renderInline(node.content, ctx);
}

export function tiptapToMjmlBody(doc: TiptapDoc, builder: MergePlanBuilder, links: LinkRegistry): string {
  const ctx: MjmlRenderContext = { builder, links };
  return (doc.content ?? [])
    .map((node) => renderBlock(node, ctx))
    .filter((block) => block !== '')
    .join('\n');
}

/** Visible text of the document — an image-only body is a spam signal (§6.6). */
export function documentTextContent(doc: TiptapDoc): string {
  const parts: string[] = [];
  const walk = (node: TiptapNode) => {
    if (node.type === 'text' && node.text) parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return parts.join(' ').trim();
}

export function documentHasImage(doc: TiptapDoc): boolean {
  let found = false;
  const walk = (node: TiptapNode) => {
    if (node.type === 'image') found = true;
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return found;
}
