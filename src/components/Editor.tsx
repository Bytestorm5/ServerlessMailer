'use client';

import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { useCallback, useEffect, useRef } from 'react';
import { clsx } from '@/lib/clsx';
import type { TiptapDoc } from '@/lib/types';

/**
 * The writing surface (§6.1).
 *
 * The supported node set is exactly: headings, bold/italic, links, lists,
 * blockquotes, images, horizontal rules. Everything else in StarterKit is
 * switched off, because the renderer cannot emit it and an editor that lets
 * you write something the send path silently drops is worse than one that
 * never offered it.
 */

export interface EditorProps {
  initialContent: TiptapDoc;
  onChange: (doc: TiptapDoc) => void;
  mergeFields: string[];
  placeholder?: string;
}

export function useNewsletterEditor({ initialContent, onChange, placeholder }: Omit<EditorProps, 'mergeFields'>) {
  // `onChange` is kept in a ref so a re-render of the parent does not
  // reconstruct the editor and lose the cursor mid-sentence.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  return useEditor({
    // Tiptap renders on the client only; rendering immediately during SSR
    // produces a hydration mismatch.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: {},
        blockquote: {},
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https'],
        HTMLAttributes: { rel: 'noopener', target: '_blank' },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write something worth reading…' }),
    ],
    content: initialContent,
    editorProps: {
      attributes: { class: 'prose-editor focus:outline-none' },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getJSON() as TiptapDoc);
    },
  });
}

function ToolbarButton({
  onClick,
  active,
  children,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(event) => {
        // Keeps the selection: losing focus before the command runs would
        // apply the mark to nothing.
        event.preventDefault();
        onClick();
      }}
      className={clsx(
        'rounded px-2 py-1 text-sm transition',
        active ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-100',
      )}
    >
      {children}
    </button>
  );
}

export function EditorToolbar({ editor, mergeFields }: { editor: TiptapEditor | null; mergeFields: string[] }) {
  const setLink = useCallback(() => {
    if (!editor) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link URL (must be absolute, http:// or https://)', previous ?? 'https://');
    if (href === null) return;
    if (href.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!/^https?:\/\//i.test(href)) {
      window.alert('Links must be absolute and start with http:// or https://.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }, [editor]);

  const addImage = useCallback(() => {
    if (!editor) return;
    const src = window.prompt('Image URL (absolute)');
    if (!src) return;
    if (!/^https?:\/\//i.test(src)) {
      window.alert('Image URLs must be absolute.');
      return;
    }
    const alt = window.prompt('Alt text (used by screen readers and when images are blocked)') ?? '';
    editor.chain().focus().setImage({ src, alt }).run();
  }, [editor]);

  const insertMergeField = useCallback(
    (field: string) => {
      if (!editor || !field) return;
      // Always inserted with a fallback, because the pre-send gate rejects a
      // merge field without one (§6.4) — better to start valid than to fail
      // the gate later.
      editor.chain().focus().insertContent(`{{ ${field} | default: "there" }}`).run();
    },
    [editor],
  );

  if (!editor) {
    return <div className="h-10 rounded border border-ink-200 bg-white" />;
  }

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded border border-ink-200 bg-white/95 px-2 py-1.5 backdrop-blur">
      <ToolbarButton title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        H1
      </ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        H3
      </ToolbarButton>

      <span className="mx-1 h-5 w-px bg-ink-200" />

      <ToolbarButton title="Bold (⌘B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton title="Italic (⌘I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton title="Link (⌘K)" active={editor.isActive('link')} onClick={setLink}>
        Link
      </ToolbarButton>

      <span className="mx-1 h-5 w-px bg-ink-200" />

      <ToolbarButton title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        • List
      </ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1. List
      </ToolbarButton>
      <ToolbarButton title="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        &ldquo; Quote
      </ToolbarButton>

      <span className="mx-1 h-5 w-px bg-ink-200" />

      <ToolbarButton title="Image" onClick={addImage}>
        Image
      </ToolbarButton>
      <ToolbarButton title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </ToolbarButton>

      <span className="mx-1 h-5 w-px bg-ink-200" />

      {/* Available fields are listed here; no free-typing of field names (§6.4). */}
      <select
        className="rounded border border-ink-200 bg-white px-2 py-1 text-sm text-ink-700"
        value=""
        onChange={(event) => {
          insertMergeField(event.target.value);
          event.target.value = '';
        }}
      >
        <option value="">Insert merge field…</option>
        {mergeFields.map((field) => (
          <option key={field} value={field}>
            {field}
          </option>
        ))}
      </select>

      <span className="ml-auto flex items-center gap-1">
        <ToolbarButton title="Undo (⌘Z)" onClick={() => editor.chain().focus().undo().run()}>
          ↶
        </ToolbarButton>
        <ToolbarButton title="Redo (⇧⌘Z)" onClick={() => editor.chain().focus().redo().run()}>
          ↷
        </ToolbarButton>
      </span>
    </div>
  );
}

export function EditorSurface({ editor }: { editor: TiptapEditor | null }) {
  useEffect(() => {
    if (!editor) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const href = window.prompt('Link URL', 'https://');
        if (href && /^https?:\/\//i.test(href)) {
          editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor]);

  return (
    <div className="rounded border border-ink-200 bg-white px-6 py-6 sm:px-10">
      <EditorContent editor={editor} />
    </div>
  );
}
