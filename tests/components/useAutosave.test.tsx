// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from '@/hooks/useAutosave';

beforeEach(() => {
  vi.useFakeTimers();
});

/** Advances timers inside act() so React processes the resulting state updates. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useAutosave', () => {
  it('starts idle and does not save an unchanged value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave({ value: 'a', onSave, delayMs: 1000 }));

    expect(result.current.status).toBe('idle');
    await advance(5000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves after the debounce elapses', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 1000 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    expect(result.current.status).toBe('pending');

    await advance(1000);

    expect(onSave).toHaveBeenCalledExactlyOnceWith('b');
    await advance(0);
    expect(result.current.status).toBe('saved');
    expect(result.current.savedAt).toBeInstanceOf(Date);
  });

  it('coalesces rapid edits into a single save', async () => {
    // Typing must not fire a request per keystroke; that is what the debounce
    // is for.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 1000 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'ab' });
    await advance(300);
    rerender({ value: 'abc' });
    await advance(300);
    rerender({ value: 'abcd' });
    await advance(1000);

    expect(onSave).toHaveBeenCalledExactlyOnceWith('abcd');
  });

  it('reports an error and keeps the change pending when the save fails', async () => {
    // Losing a draft silently is unacceptable: the writer must see that their
    // work is not saved.
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 500 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    await advance(500);

    await advance(0);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('network down');
  });

  it('retries a failed save on the next change', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 500 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    await advance(500);
    await advance(0);
    expect(result.current.status).toBe('error');

    rerender({ value: 'c' });
    await advance(500);
    await advance(0);
    expect(result.current.status).toBe('saved');
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('saveNow flushes immediately without waiting for the debounce', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 10_000 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    await act(async () => {
      await result.current.saveNow();
    });

    expect(onSave).toHaveBeenCalledExactlyOnceWith('b');
    // The pending timer must not fire a second, redundant save.
    await advance(10_000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('does not save after unmount', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 1000 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    unmount();
    await advance(2000);

    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not overlap saves when a change lands mid-flight', async () => {
    let resolveFirst: () => void = () => {};
    const onSave = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ value }) => useAutosave({ value, onSave, delayMs: 500 }),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    await advance(500);
    expect(onSave).toHaveBeenCalledTimes(1);

    // A second edit while the first save is still in flight must queue, not
    // race — an out-of-order write would resurrect older copy.
    rerender({ value: 'c' });
    await advance(500);
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
    });
    await advance(500);

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('c');
  });
});
