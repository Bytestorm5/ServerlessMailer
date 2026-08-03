// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignPreview } from '@/components/campaign/CampaignPreview';

const SUBSCRIBERS = [
  { id: 'sub-1', email: 'ada@example.com', label: 'ada@example.com — first_name: Ada' },
  { id: 'sub-2', email: 'noname@example.com', label: 'noname@example.com — no first_name' },
];

function setup(overrides: Partial<React.ComponentProps<typeof CampaignPreview>> = {}) {
  const onSelectSubscriber = vi.fn();
  render(
    <CampaignPreview
      html="<html><body><p>Hello Ada</p></body></html>"
      text={'Hello Ada\n\nUnsubscribe: https://mail.example.com/u'}
      subscribers={SUBSCRIBERS}
      selectedSubscriberId="sub-1"
      onSelectSubscriber={onSelectSubscriber}
      {...overrides}
    />,
  );
  return { onSelectSubscriber };
}

describe('CampaignPreview — rendering', () => {
  it('renders the HTML inside a sandboxed frame', async () => {
    // Campaign HTML is operator-authored but may embed arbitrary markup; it must
    // not run script in the admin origin.
    setup();
    const frame = screen.getByTitle(/email preview/i) as HTMLIFrameElement;

    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Hello Ada');
  });

  it('shows the plain-text alternative on its own tab', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('tab', { name: /plain text/i }));

    expect(screen.getByRole('tabpanel')).toHaveTextContent('Hello Ada');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Unsubscribe:');
  });

  it('starts on the HTML tab', () => {
    setup();
    expect(screen.getByRole('tab', { name: /html/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('CampaignPreview — width toggle', () => {
  it('offers desktop and mobile widths', () => {
    setup();
    expect(screen.getByRole('radio', { name: /desktop/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /mobile/i })).toBeInTheDocument();
  });

  it('narrows the frame when mobile is selected', async () => {
    const user = userEvent.setup();
    setup();
    const frame = screen.getByTitle(/email preview/i);
    const desktopWidth = frame.style.width;

    await user.click(screen.getByRole('radio', { name: /mobile/i }));

    expect(frame.style.width).not.toBe(desktopWidth);
    expect(frame.style.width).toBe('375px');
  });
});

describe('CampaignPreview — merge data', () => {
  it('lets the operator preview as a real subscriber', async () => {
    // §6.3: preview renders with a real subscriber's merge data, selectable
    // from a dropdown, so fallbacks get exercised.
    const user = userEvent.setup();
    const { onSelectSubscriber } = setup();

    const select = screen.getByRole('combobox', { name: /preview as/i });
    expect(within(select).getAllByRole('option')).toHaveLength(2);

    await user.selectOptions(select, 'sub-2');

    expect(onSelectSubscriber).toHaveBeenCalledWith('sub-2');
  });

  it('explains why the dropdown is empty when there are no subscribers yet', () => {
    setup({ subscribers: [], selectedSubscriberId: undefined });
    expect(screen.getByText(/no confirmed subscribers/i)).toBeInTheDocument();
  });
});

describe('CampaignPreview — states', () => {
  it('signals a re-render with aria-busy and no visible text', () => {
    // A visible "updating…" line appeared and vanished on every keystroke,
    // reflowing the toolbar under the writer's cursor.
    setup({ loading: true });

    expect(screen.getByRole('region', { name: /preview/i })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/updating|rendering/i)).toBeNull();
  });

  it('surfaces a render failure instead of showing a stale preview', () => {
    // Silently showing the last good render would let someone send a campaign
    // whose current body does not render at all.
    setup({ error: 'MJML: unexpected element mj-foo' });

    expect(screen.getByRole('alert')).toHaveTextContent('mj-foo');
    expect(screen.queryByTitle(/email preview/i)).toBeNull();
  });
});
