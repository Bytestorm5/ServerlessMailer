// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignEditorScreen } from '@/components/campaign/CampaignEditorScreen';
import type { EditorDoc, PresendResult } from '@/lib/types';

const BODY: EditorDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

const PASSING: PresendResult = {
  passed: true,
  recipientCount: 480,
  checks: [{ id: 'subject', label: 'Subject line is present', passed: true }],
};

const FAILING: PresendResult = {
  passed: false,
  recipientCount: 480,
  checks: [
    { id: 'subject', label: 'Subject line is present', passed: true },
    {
      id: 'unsubscribe_placeholder',
      label: 'Unsubscribe link is present in the email',
      passed: false,
      detail: 'Legally required',
    },
  ],
};

function setup(overrides: Partial<React.ComponentProps<typeof CampaignEditorScreen>> = {}) {
  const handlers = {
    onSave: vi.fn().mockResolvedValue(undefined),
    onRenderPreview: vi
      .fn()
      .mockResolvedValue({ html: '<html><body>Hello world</body></html>', text: 'Hello world' }),
    onValidate: vi.fn().mockResolvedValue(PASSING),
    onSend: vi.fn().mockResolvedValue(undefined),
    onTestSend: vi.fn().mockResolvedValue(undefined),
    onRestoreVersion: vi.fn().mockResolvedValue(undefined),
  };

  render(
    <CampaignEditorScreen
      initialDraft={{ subject: 'This week', preheader: 'The short version', bodySource: BODY }}
      listName="Domain A Weekly"
      fromName="Domain A"
      fromEmail="hello@news.domain-a.com"
      replyTo="hello@domain-a.com"
      mergeFields={[
        { key: 'first_name', label: 'First name', system: false },
      ]}
      previewSubscribers={[{ id: 'sub-1', email: 'ada@example.com', label: 'ada@example.com' }]}
      versions={[{ id: 'v1', createdAt: '2026-07-31T10:00:00.000Z', subject: 'Older draft' }]}
      typedConfirmationThreshold={1000}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('CampaignEditorScreen — composing', () => {
  it('renders the subject, preheader and body', async () => {
    setup();
    expect(screen.getByLabelText(/subject line/i)).toHaveValue('This week');
    expect(screen.getByLabelText(/preheader/i)).toHaveValue('The short version');
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
  });

  it('renders a live preview of the current draft', async () => {
    const { onRenderPreview } = setup();
    await waitFor(() => expect(onRenderPreview).toHaveBeenCalled());
    expect(screen.getByTitle(/email preview/i)).toBeInTheDocument();
  });

  it('re-renders the preview when a different subscriber is chosen', async () => {
    const user = userEvent.setup();
    const { onRenderPreview } = setup({
      previewSubscribers: [
        { id: 'sub-1', email: 'a@example.com', label: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com', label: 'b@example.com' },
      ],
    });
    await waitFor(() => expect(onRenderPreview).toHaveBeenCalled());
    const before = onRenderPreview.mock.calls.length;

    await user.selectOptions(screen.getByRole('combobox', { name: /preview as/i }), 'sub-2');

    await waitFor(() =>
      expect(onRenderPreview.mock.calls.length).toBeGreaterThan(before),
    );
    expect(onRenderPreview.mock.calls.at(-1)![1]).toBe('sub-2');
  });

  it('autosaves an edited subject and shows the saved state', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.type(screen.getByLabelText(/subject line/i), '!');

    await waitFor(() => expect(onSave).toHaveBeenCalled(), { timeout: 4000 });
    expect(onSave.mock.calls.at(-1)![0].subject).toBe('This week!');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));
  });

  it('shows an unmistakable warning when a save fails', async () => {
    const user = userEvent.setup();
    setup({ onSave: vi.fn().mockRejectedValue(new Error('offline')) });

    await user.type(screen.getByLabelText(/subject line/i), '!');

    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent(/not saved/i),
      { timeout: 4000 },
    );
  });

  it('surfaces a preview render failure rather than a stale preview', async () => {
    setup({ onRenderPreview: vi.fn().mockRejectedValue(new Error('MJML exploded')) });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('MJML exploded'));
    expect(screen.queryByTitle(/email preview/i)).toBeNull();
  });
});

describe('CampaignEditorScreen — sending', () => {
  it('saves and validates before opening the confirmation', async () => {
    const user = userEvent.setup();
    const { onSave, onValidate } = setup();

    await user.type(screen.getByLabelText(/subject line/i), '!');
    await user.click(screen.getByRole('button', { name: /review and send/i }));

    // The draft must reach the server before the send is authorised.
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onValidate).toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('restates the send in the confirmation dialog', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /review and send/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('480');
    expect(dialog).toHaveTextContent('Domain A Weekly');
    expect(dialog).toHaveTextContent('hello@news.domain-a.com');
  });

  it('sends when the operator confirms', async () => {
    const user = userEvent.setup();
    const { onSend } = setup();

    await user.click(screen.getByRole('button', { name: /review and send/i }));
    await user.click(await screen.findByRole('button', { name: /send to 480/i }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('cannot send when the pre-send gate fails', async () => {
    const user = userEvent.setup();
    const { onSend } = setup({ onValidate: vi.fn().mockResolvedValue(FAILING) });

    await user.click(screen.getByRole('button', { name: /review and send/i }));
    const dialog = await screen.findByRole('dialog');

    expect(dialog).toHaveTextContent('Unsubscribe link is present in the email');
    expect(screen.getByRole('button', { name: /send to 480/i })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('cancels without sending', async () => {
    const user = userEvent.setup();
    const { onSend } = setup();

    await user.click(screen.getByRole('button', { name: /review and send/i }));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('CampaignEditorScreen — test sends and history', () => {
  it('flushes a pending edit before sending the test', async () => {
    // A test send must exercise the draft as it stands, not the last copy that
    // happened to reach the server.
    const user = userEvent.setup();
    const { onSave, onTestSend } = setup();

    await user.type(screen.getByLabelText(/subject line/i), '!');
    await user.type(screen.getByLabelText(/send a test to/i), 'me@example.com');
    await user.click(screen.getByRole('button', { name: /send test/i }));

    await waitFor(() => expect(onTestSend).toHaveBeenCalledWith(['me@example.com']));
    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls.at(-1)![0].subject).toBe('This week!');
  });

  it('will not send a test to an empty address', async () => {
    setup();
    expect(screen.getByRole('button', { name: /send test/i })).toBeDisabled();
  });

  it('offers recoverable version history', async () => {
    const user = userEvent.setup();
    const { onRestoreVersion } = setup();

    await user.click(screen.getByText(/version history/i));
    await user.click(screen.getByRole('button', { name: /restore/i }));

    expect(onRestoreVersion).toHaveBeenCalledWith('v1');
  });
});

describe('CampaignEditorScreen — HTML body mode', () => {
  /**
   * Scoped: the preview panel has its own HTML / Plain text tabs, and an
   * unscoped query for a tab named "HTML" matches both tablists.
   */
  const modeTab = (name: RegExp) =>
    within(screen.getByRole('tablist', { name: /body format/i })).getByRole('tab', { name });

  it('starts on the rich text editor', () => {
    setup();
    expect(modeTab(/rich text/i)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText(/body html/i)).toBeNull();
  });

  it('swaps the editor for a paste box when HTML is chosen', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(modeTab(/^html$/i));

    expect(screen.getByLabelText(/body html/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /newsletter body/i })).toBeNull();
  });

  it('saves the pasted HTML and the mode alongside it', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.click(modeTab(/^html$/i));
    await user.type(screen.getByLabelText(/body html/i), '<p>Pasted</p>');

    await waitFor(
      () =>
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ bodyMode: 'html', bodyHtmlSource: '<p>Pasted</p>' }),
        ),
      { timeout: 4000 },
    );
  });

  it('previews the pasted HTML rather than the editor document', async () => {
    const user = userEvent.setup();
    const { onRenderPreview } = setup();

    await user.click(modeTab(/^html$/i));
    await user.type(screen.getByLabelText(/body html/i), '<p>x</p>');

    await waitFor(() =>
      expect(onRenderPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ bodyMode: 'html', bodyHtmlSource: '<p>x</p>' }),
        expect.anything(),
      ),
    );
  });

  it('says whether the paste fills the template slot or replaces the template', async () => {
    const user = userEvent.setup();
    setup({
      initialDraft: {
        subject: 'This week',
        preheader: 'The short version',
        bodySource: BODY,
        bodyMode: 'html',
        bodyHtmlSource: '<p>A fragment</p>',
      },
    });

    expect(screen.getByText(/goes into the list template/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/body html/i));
    await user.type(
      screen.getByLabelText(/body html/i),
      '<!DOCTYPE html><html><body>whole</body></html>',
    );

    expect(await screen.findByText(/whole document/i)).toBeInTheDocument();
  });

  it('keeps both sources, so switching back costs nothing', async () => {
    const user = userEvent.setup();
    setup({
      initialDraft: {
        subject: 'This week',
        preheader: 'The short version',
        bodySource: BODY,
        bodyMode: 'html',
        bodyHtmlSource: '<p>Pasted</p>',
      },
    });

    await user.click(modeTab(/rich text/i));
    expect(await screen.findByText('Hello world')).toBeInTheDocument();

    await user.click(modeTab(/^html$/i));
    expect(screen.getByLabelText(/body html/i)).toHaveValue('<p>Pasted</p>');
  });
});
