// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { NewsletterEditor } from '@/components/editor/NewsletterEditor';
import type { EditorDoc } from '@/lib/types';

const MERGE_FIELDS = [
  { key: 'first_name', label: 'First name', description: 'Subscriber first name', system: false },
  { key: 'unsubscribe_url', label: 'Unsubscribe URL', description: 'One-click link', system: true },
];

function paragraph(text: string): EditorDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** Renders the editor and exposes the latest emitted document for assertions. */
function Harness({
  initialDoc = paragraph('Hello world'),
  onChange,
}: {
  initialDoc?: EditorDoc;
  onChange?: (doc: EditorDoc) => void;
}) {
  const [doc, setDoc] = useState<EditorDoc>(initialDoc);
  return (
    <>
      <NewsletterEditor
        initialDoc={initialDoc}
        mergeFields={MERGE_FIELDS}
        onChange={(next) => {
          setDoc(next);
          onChange?.(next);
        }}
      />
      <pre data-testid="doc">{JSON.stringify(doc)}</pre>
    </>
  );
}

function docJson(): EditorDoc {
  return JSON.parse(screen.getByTestId('doc').textContent ?? '{}');
}

/** Concatenated text of the document, for assertions about inserted tokens. */
function allText(doc: EditorDoc): string {
  let out = '';
  const walk = (nodes: EditorDoc['content'] = []) => {
    for (const node of nodes) {
      if (typeof node.text === 'string') out += node.text;
      if (node.content) walk(node.content);
    }
  };
  walk(doc.content);
  return out;
}

function types(doc: EditorDoc): string[] {
  const out: string[] = [];
  const walk = (nodes: EditorDoc['content'] = []) => {
    for (const node of nodes) {
      out.push(node.type);
      if (node.content) walk(node.content);
      for (const mark of node.marks ?? []) out.push(`mark:${mark.type}`);
    }
  };
  walk(doc.content);
  return out;
}

async function surface() {
  return screen.findByRole('textbox', { name: /newsletter body/i });
}

describe('NewsletterEditor — rendering', () => {
  it('renders the initial document', async () => {
    render(<Harness />);
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
  });

  it('exposes the writing surface as a labelled textbox', async () => {
    render(<Harness />);
    expect(await surface()).toBeInTheDocument();
  });

  it('renders a heading from the initial document', async () => {
    render(
      <Harness
        initialDoc={{
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Big news' }] },
          ],
        }}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Big news' })).toBeInTheDocument();
  });
});

describe('NewsletterEditor — the toolbar is the complete formatting list', () => {
  it('offers exactly the formatting the spec allows', async () => {
    // §6.1: headings, bold/italic, links, lists, blockquotes, images and
    // horizontal rules. "That is the complete list. Resist additions."
    render(<Harness />);
    await surface();

    for (const name of [
      /bold/i,
      /italic/i,
      /link/i,
      /heading 2/i,
      /heading 3/i,
      /bulleted list/i,
      /numbered list/i,
      /quote/i,
      /image/i,
      /divider/i,
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('offers no control outside that list', async () => {
    render(<Harness />);
    await surface();

    for (const name of [/strikethrough/i, /underline/i, /code/i, /colour|color/i, /font/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('NewsletterEditor — formatting', () => {
  it('applies bold to the selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /bold/i }));

    await waitFor(() => expect(types(docJson())).toContain('mark:bold'));
  });

  it('applies italic to the selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /italic/i }));

    await waitFor(() => expect(types(docJson())).toContain('mark:italic'));
  });

  it('turns a paragraph into a heading', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /heading 2/i }));

    await waitFor(() => expect(types(docJson())).toContain('heading'));
  });

  it('creates a bulleted list', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /bulleted list/i }));

    await waitFor(() => expect(types(docJson())).toContain('bulletList'));
  });

  it('creates a blockquote', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /quote/i }));

    await waitFor(() => expect(types(docJson())).toContain('blockquote'));
  });

  it('inserts a horizontal rule', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /divider/i }));

    await waitFor(() => expect(types(docJson())).toContain('horizontalRule'));
  });

  it('marks the active formatting as pressed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /heading 2/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /heading 2/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });
});

describe('NewsletterEditor — the closed node set is enforced', () => {
  it('does not turn a markdown code fence into a code block', async () => {
    const user = userEvent.setup();
    render(<Harness initialDoc={paragraph('')} />);
    const editor = await surface();

    await user.click(editor);
    await user.keyboard('```{Enter}const x = 1');

    await waitFor(() => expect(docJson().content.length).toBeGreaterThan(0));
    expect(types(docJson())).not.toContain('codeBlock');
  });

  it('does not apply strikethrough from a markdown shortcut', async () => {
    const user = userEvent.setup();
    render(<Harness initialDoc={paragraph('')} />);
    const editor = await surface();

    await user.click(editor);
    await user.keyboard('~~struck~~ ');

    await waitFor(() => expect(types(docJson())).toContain('text'));
    expect(types(docJson())).not.toContain('mark:strike');
  });
});

describe('NewsletterEditor — links', () => {
  it('adds a link to the selection', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('https://example.com/post');
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /link/i }));

    await waitFor(() => expect(types(docJson())).toContain('mark:link'));
    const link = JSON.stringify(docJson());
    expect(link).toContain('https://example.com/post');
  });

  it('refuses a javascript: URL', async () => {
    // An unvalidated href in an email body is an XSS vector in every webmail
    // client that renders it.
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('javascript:alert(1)');
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /link/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/valid|http/i));
    expect(types(docJson())).not.toContain('mark:link');
  });

  it('leaves the document untouched when the prompt is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /link/i }));

    expect(types(docJson())).not.toContain('mark:link');
  });

  it('refuses a relative URL, which would break in an email client', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('/blog/post');
    render(<Harness />);
    const editor = await surface();

    await user.tripleClick(editor);
    await user.click(screen.getByRole('button', { name: /link/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(types(docJson())).not.toContain('mark:link');
  });
});

describe('NewsletterEditor — images', () => {
  it('inserts an image from an absolute URL', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('https://cdn.example.com/a.png');
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /image/i }));

    await waitFor(() => expect(types(docJson())).toContain('image'));
  });

  it('refuses a non-http image source', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('javascript:alert(1)');
    render(<Harness />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /image/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(types(docJson())).not.toContain('image');
  });
});

describe('NewsletterEditor — merge fields', () => {
  it('lists the available fields rather than allowing free typing', async () => {
    // §6.4: available fields are listed in the editor UI; no free-typing of
    // field names.
    const user = userEvent.setup();
    render(<Harness />);
    await surface();

    await user.click(screen.getByRole('button', { name: /merge field/i }));

    expect(await screen.findByRole('menuitem', { name: /first name/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /unsubscribe url/i })).toBeInTheDocument();
  });

  it('inserts a non-system field complete with a fallback', async () => {
    // Every merge field must have a fallback (§6.4), so the editor never
    // produces one without it.
    const user = userEvent.setup();
    render(<Harness initialDoc={paragraph('')} />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /merge field/i }));
    await user.click(await screen.findByRole('menuitem', { name: /first name/i }));

    await waitFor(() =>
      expect(allText(docJson())).toContain('{{ first_name | default: "there" }}'),
    );
  });

  it('inserts a system field without a fallback', async () => {
    const user = userEvent.setup();
    render(<Harness initialDoc={paragraph('')} />);
    const editor = await surface();

    await user.click(editor);
    await user.click(screen.getByRole('button', { name: /merge field/i }));
    await user.click(await screen.findByRole('menuitem', { name: /unsubscribe url/i }));

    await waitFor(() => expect(allText(docJson())).toContain('{{ unsubscribe_url }}'));
  });
});

describe('NewsletterEditor — change reporting', () => {
  it('emits the document as editor JSON on every edit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initialDoc={paragraph('')} onChange={onChange} />);
    const editor = await surface();

    await user.click(editor);
    await user.keyboard('New copy');

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as EditorDoc;
    expect(last.type).toBe('doc');
    expect(JSON.stringify(last)).toContain('New copy');
  });
});
