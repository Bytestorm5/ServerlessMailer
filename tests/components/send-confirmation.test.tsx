// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SendConfirmationModal } from '@/components/campaign/SendConfirmationModal';
import type { PresendCheck } from '@/lib/types';

const PASSING_CHECKS: PresendCheck[] = [
  { id: 'subject', label: 'Subject line present', passed: true },
  { id: 'unsubscribe_placeholder', label: 'Unsubscribe link present', passed: true },
];

function setup(overrides: Partial<React.ComponentProps<typeof SendConfirmationModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SendConfirmationModal
      open
      recipientCount={480}
      listName="Domain A Weekly"
      fromName="Domain A"
      fromEmail="hello@news.domain-a.com"
      replyTo="hello@domain-a.com"
      subject="This week from Domain A"
      typedConfirmationThreshold={1000}
      checks={PASSING_CHECKS}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('SendConfirmationModal — restating the facts', () => {
  it('restates recipient count, list, from, reply-to and subject', async () => {
    // §6.7: this is the last human checkpoint before 19,000 people receive
    // something, so every fact they need is on screen in plain language.
    setup();
    const dialog = screen.getByRole('dialog');

    expect(dialog).toHaveTextContent('480');
    expect(dialog).toHaveTextContent('Domain A Weekly');
    expect(dialog).toHaveTextContent('hello@news.domain-a.com');
    expect(dialog).toHaveTextContent('hello@domain-a.com');
    expect(dialog).toHaveTextContent('This week from Domain A');
  });

  it('formats a large recipient count readably', () => {
    setup({ recipientCount: 19482, typedConfirmationThreshold: 100000 });
    expect(screen.getByRole('dialog')).toHaveTextContent('19,482');
  });

  it('renders nothing when closed', () => {
    setup({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SendConfirmationModal — below the typed-confirmation threshold', () => {
  it('sends on a single confirmation click', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    await user.click(screen.getByRole('button', { name: /send to 480/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not ask the operator to type anything', () => {
    setup();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cancels without sending', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('SendConfirmationModal — above the typed-confirmation threshold', () => {
  it('requires the operator to type the recipient count', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ recipientCount: 19482 });

    const send = screen.getByRole('button', { name: /send to 19,482/i });
    expect(send).toBeDisabled();

    await user.click(send);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), '19482');
    expect(send).toBeEnabled();

    await user.click(send);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('stays disabled for a wrong number', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ recipientCount: 19482 });

    await user.type(screen.getByRole('textbox'), '19481');

    expect(screen.getByRole('button', { name: /send to/i })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('accepts the count typed with separators', async () => {
    const user = userEvent.setup();
    setup({ recipientCount: 19482 });

    await user.type(screen.getByRole('textbox'), '19,482');

    expect(screen.getByRole('button', { name: /send to/i })).toBeEnabled();
  });
});

describe('SendConfirmationModal — the pre-send gate is a hard block', () => {
  const failing: PresendCheck[] = [
    { id: 'subject', label: 'Subject line present', passed: true },
    {
      id: 'merge_fallbacks',
      label: 'All merge fields have fallbacks',
      passed: false,
      detail: 'first_name has no fallback',
    },
  ];

  it('disables sending when any check fails', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ checks: failing });

    const send = screen.getByRole('button', { name: /send to/i });
    expect(send).toBeDisabled();

    await user.click(send);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('names the failing check and its detail', () => {
    setup({ checks: failing });

    expect(screen.getByRole('dialog')).toHaveTextContent('All merge fields have fallbacks');
    expect(screen.getByRole('dialog')).toHaveTextContent('first_name has no fallback');
  });

  it('offers no override', () => {
    // §6.6: hard block, no override.
    setup({ checks: failing });

    expect(screen.queryByRole('button', { name: /override|force|send anyway/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /override|ignore/i })).toBeNull();
  });

  it('blocks a zero-recipient send even when every check passes', async () => {
    setup({ recipientCount: 0 });
    expect(screen.getByRole('button', { name: /send to/i })).toBeDisabled();
  });
});

describe('SendConfirmationModal — accessibility', () => {
  it('is a labelled modal dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
