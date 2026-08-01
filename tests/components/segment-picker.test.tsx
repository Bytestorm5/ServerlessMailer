// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentPicker } from '@/components/campaign/SegmentPicker';
import type { SegmentQuery } from '@/lib/types';

function setup(
  overrides: Partial<React.ComponentProps<typeof SegmentPicker>> = {},
) {
  const onChange = vi.fn();
  render(
    <SegmentPicker
      value={{}}
      onChange={onChange}
      count={12481}
      {...overrides}
    />,
  );
  return { onChange };
}

/** The patch the picker emitted, merged onto the value it was given. */
function emitted(onChange: ReturnType<typeof vi.fn>): SegmentQuery {
  return onChange.mock.calls.at(-1)![0] as SegmentQuery;
}

describe('SegmentPicker — the live count', () => {
  it('states the recipient count in plain language', () => {
    // §4.2: "this will send to 12,481 people".
    setup();
    expect(screen.getByRole('status')).toHaveTextContent('12,481 people');
  });

  it('uses the singular for one person', () => {
    setup({ count: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('1 person');
  });

  it('says it is counting rather than showing a stale number', () => {
    setup({ count: null });
    expect(screen.getByRole('status')).toHaveTextContent(/counting/i);
  });

  it('says the count is recalculated at send time', () => {
    // The count here is advisory; the number that matters is re-derived at
    // freeze and never trusted from the UI.
    setup();
    expect(screen.getByText(/recalculated when you send/i)).toBeInTheDocument();
  });

  it('says only confirmed subscribers are included', () => {
    setup();
    expect(screen.getByText(/only confirmed subscribers/i)).toBeInTheDocument();
  });

  it('shows an error instead of a count when the segment is invalid', () => {
    setup({ error: 'Invalid signedUpAfter in segment query' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid signedUpAfter');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('SegmentPicker — the controls are dropdowns, not a query builder', () => {
  it('offers a small fixed set of filters', () => {
    // §4.2: "The UI presents these as a small set of dropdowns, not a query
    // builder."
    setup();
    expect(screen.getByLabelText(/source/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/signed up after/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/signed up before/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/engagement/i)).toBeInTheDocument();
  });

  it('offers no free-text query input', () => {
    setup();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('filters by signup source', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.selectOptions(screen.getByLabelText(/source/i), 'import');

    expect(emitted(onChange).source).toBe('import');
  });

  it('clears the source filter back to undefined', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: { source: 'import' } });

    await user.selectOptions(screen.getByLabelText(/source/i), '');

    expect(emitted(onChange).source).toBeUndefined();
  });

  it('turns a signup date into an ISO instant', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.type(screen.getByLabelText(/signed up after/i), '2026-01-15');

    expect(emitted(onChange).signedUpAfter).toBe('2026-01-15T00:00:00.000Z');
  });

  it('renders an existing date range back into the inputs', () => {
    setup({
      value: {
        signedUpAfter: '2026-01-15T00:00:00.000Z',
        signedUpBefore: '2026-02-01T00:00:00.000Z',
      },
    });

    expect(screen.getByLabelText(/signed up after/i)).toHaveValue('2026-01-15');
    expect(screen.getByLabelText(/signed up before/i)).toHaveValue('2026-02-01');
  });

  it('offers an engagement filter, which is what makes a warmup possible', async () => {
    // §10.4: ramp over 2-4 weeks, most-engaged segments first. The segment UI
    // must support this.
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.selectOptions(screen.getByLabelText(/engagement/i), '3');

    expect(emitted(onChange).openedInLastNCampaigns).toBe(3);
  });

  it('preserves filters it is not changing', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: { source: 'web_form' } });

    await user.selectOptions(screen.getByLabelText(/engagement/i), '5');

    expect(emitted(onChange)).toEqual({
      source: 'web_form',
      openedInLastNCampaigns: 5,
    });
  });
});
