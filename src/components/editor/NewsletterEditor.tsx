'use client';

import { useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { EditorToolbar, type MergeFieldOption } from '@/components/editor/EditorToolbar';
import { newsletterExtensions } from '@/components/editor/extensions';
import type { EditorDoc } from '@/lib/types';

export interface NewsletterEditorProps {
  initialDoc: EditorDoc;
  mergeFields: MergeFieldOption[];
  onChange?: (doc: EditorDoc) => void;
  placeholder?: string;
}

/**
 * The daily-use writing surface (spec §6).
 *
 * Full-width and distraction-light on purpose: if this is unpleasant, the
 * project has failed regardless of how correct the backend is. The document
 * JSON it emits is the campaign's source of truth — HTML is only ever a render
 * target.
 */
export function NewsletterEditor({
  initialDoc,
  mergeFields,
  onChange,
  placeholder,
}: NewsletterEditorProps) {
  const [error, setError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: newsletterExtensions(placeholder),
    content: initialDoc,
    // Next.js renders this on the server first; letting Tiptap render
    // immediately would produce a hydration mismatch.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Newsletter body',
        class: 'sm-editor-surface',
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange?.(instance.getJSON() as EditorDoc);
    },
  });

  if (!editor) {
    return <div className="sm-editor" aria-busy="true" />;
  }

  return (
    <div className="sm-editor">
      <EditorToolbar editor={editor} mergeFields={mergeFields} onError={setError} />
      {error && (
        <p role="alert" className="sm-editor-error">
          {error}
        </p>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
