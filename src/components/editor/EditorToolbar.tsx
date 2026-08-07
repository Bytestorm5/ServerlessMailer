'use client';

import { useState } from 'react';
import {
  Bold,
  Braces,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  TextQuote,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { isSafeAbsoluteUrl } from '@/components/editor/extensions';

export interface MergeFieldOption {
  key: string;
  label: string;
  description?: string;
  system: boolean;
}

interface ToolbarProps {
  editor: Editor;
  mergeFields: MergeFieldOption[];
  onError: (message: string | null) => void;
}

interface ControlProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Control({ label, active, onClick, children }: ControlProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ?? false}
      onClick={onClick}
      className={`sm-toolbar-button${active ? ' is-active' : ''}`}
    >
      {children}
    </button>
  );
}

/**
 * The complete formatting surface (spec §6.1). Anything not on this bar is not
 * expressible in a campaign, by design.
 */
export function EditorToolbar({ editor, mergeFields, onError }: ToolbarProps) {
  const [mergeOpen, setMergeOpen] = useState(false);

  const promptForUrl = (message: string): string | null => {
    const input = window.prompt(message);
    if (input === null) return null;
    const trimmed = input.trim();
    if (!isSafeAbsoluteUrl(trimmed)) {
      onError(
        'Enter a full web address starting with https:// — relative links break in email clients.',
      );
      return null;
    }
    onError(null);
    return trimmed;
  };

  const insertMergeField = (field: MergeFieldOption) => {
    // Every non-system merge field is inserted complete with a fallback, so the
    // pre-send gate's "all merge fields have fallbacks" check cannot fail
    // because of something typed here (§6.4).
    const token = field.system
      ? `{{ ${field.key} }}`
      : `{{ ${field.key} | default: "there" }}`;
    editor.chain().focus().insertContent(token).run();
    setMergeOpen(false);
  };

  return (
    <div className="sm-toolbar" role="toolbar" aria-label="Formatting">
      <Control
        label="Bold"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold aria-hidden />
      </Control>
      <Control
        label="Italic"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic aria-hidden />
      </Control>

      <span className="sm-toolbar-divider" aria-hidden="true" />

      <Control
        label="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 aria-hidden />
      </Control>
      <Control
        label="Heading 3"
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 aria-hidden />
      </Control>

      <span className="sm-toolbar-divider" aria-hidden="true" />

      <Control
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List aria-hidden />
      </Control>
      <Control
        label="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered aria-hidden />
      </Control>
      <Control
        label="Quote"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <TextQuote aria-hidden />
      </Control>

      <span className="sm-toolbar-divider" aria-hidden="true" />

      <Control
        label="Link"
        active={editor.isActive('link')}
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const href = promptForUrl('Link address');
          if (!href) return;
          editor.chain().focus().setLink({ href }).run();
        }}
      >
        <Link aria-hidden />
      </Control>
      <Control
        label="Image"
        onClick={() => {
          const src = promptForUrl('Image address');
          if (!src) return;
          editor.chain().focus().setImage({ src }).run();
        }}
      >
        <Image aria-hidden />
      </Control>
      <Control
        label="Divider"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus aria-hidden />
      </Control>

      <span className="sm-toolbar-divider" aria-hidden="true" />

      <div className="sm-merge">
        <button
          type="button"
          aria-label="Merge field"
          aria-haspopup="menu"
          aria-expanded={mergeOpen}
          onClick={() => setMergeOpen((open) => !open)}
          className="sm-toolbar-button"
        >
          <Braces aria-hidden />
          Merge field
        </button>
        {mergeOpen && (
          <div className="sm-merge-menu" role="menu" aria-label="Merge fields">
            {mergeFields.map((field) => (
              <button
                key={field.key}
                type="button"
                role="menuitem"
                onClick={() => insertMergeField(field)}
              >
                <span>{field.label}</span>
                {field.description && <small>{field.description}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
