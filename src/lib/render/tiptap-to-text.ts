import { compileMergeFields, type MergePlanBuilder } from '../merge';
import type { TiptapDoc, TiptapNode } from '../types';
import type { LinkRegistry } from './link-registry';

/**
 * Tiptap JSON → plain text.
 *
 * A plain-text alternative is not optional: HTML-only sends carry a
 * deliverability penalty (§6.2). This produces something a person can
 * comfortably read, not a tag-stripped approximation — links are rendered with
 * their target inline, lists keep their markers, headings keep their weight
 * through underlining.
 */

interface TextContext {
  builder: MergePlanBuilder;
  /** Shared with the HTML render so both parts resolve to identical targets. */
  links: LinkRegistry;
}

function inlineText(nodes: TiptapNode[] | undefined, ctx: TextContext): string {
  if (!nodes) return '';
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '\n';
      if (node.type === 'text') {
        const text = compileMergeFields(node.text ?? '', ctx.builder);
        const link = node.marks?.find((m) => m.type === 'link');
        if (link) {
          // Placeholder resolved alongside the HTML version so a tracked send
          // rewrites both parts identically.
          const placeholder = ctx.links.add(String(link.attrs?.href ?? ''));
          if (placeholder !== null) return `${text} <${placeholder}>`;
        }
        return text;
      }
      return inlineText(node.content, ctx);
    })
    .join('');
}

function wrap(text: string, width = 78): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line;
      const words = line.split(' ');
      const out: string[] = [];
      let current = '';
      for (const word of words) {
        if (current === '') current = word;
        else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
        else {
          out.push(current);
          current = word;
        }
      }
      if (current) out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

function listToText(node: TiptapNode, ctx: TextContext, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth);
  let counter = 0;
  return (node.content ?? [])
    .filter((item) => item.type === 'listItem')
    .map((item) => {
      counter += 1;
      const marker = ordered ? `${counter}. ` : '- ';
      const parts: string[] = [];
      for (const child of item.content ?? []) {
        if (child.type === 'bulletList') parts.push('\n' + listToText(child, ctx, false, depth + 1));
        else if (child.type === 'orderedList') parts.push('\n' + listToText(child, ctx, true, depth + 1));
        else parts.push(inlineText(child.content, ctx));
      }
      return `${indent}${marker}${parts.join('')}`;
    })
    .join('\n');
}

function blockToText(node: TiptapNode, ctx: TextContext): string {
  switch (node.type) {
    case 'paragraph':
      return wrap(inlineText(node.content, ctx));
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2);
      const text = inlineText(node.content, ctx);
      const rule = (level <= 2 ? '=' : '-').repeat(Math.min(72, Math.max(3, text.length)));
      return `${wrap(text)}\n${rule}`;
    }
    case 'bulletList':
      return listToText(node, ctx, false, 0);
    case 'orderedList':
      return listToText(node, ctx, true, 0);
    case 'blockquote':
      return (node.content ?? [])
        .map((child) => blockToText(child, ctx))
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'horizontalRule':
      return '---';
    case 'image': {
      const alt = String(node.attrs?.alt ?? '').trim();
      const src = String(node.attrs?.src ?? '');
      return alt ? `[Image: ${alt}]${src ? ` ${src}` : ''}` : src ? `[Image] ${src}` : '';
    }
    default:
      return '';
  }
}

export function tiptapToText(doc: TiptapDoc, builder: MergePlanBuilder, links: LinkRegistry): string {
  const ctx: TextContext = { builder, links };
  return (doc.content ?? [])
    .map((node) => blockToText(node, ctx))
    .filter((block) => block.trim() !== '')
    .join('\n\n');
}
