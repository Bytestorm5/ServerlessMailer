'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface UseAutosaveOptions<T> {
  value: T;
  onSave: (value: T) => Promise<void>;
  delayMs?: number;
}

export interface UseAutosaveResult {
  status: SaveStatus;
  savedAt: Date | null;
  error: string | null;
  saveNow: () => Promise<void>;
}

/**
 * Debounced autosave with a visible saved-state (spec §6.1).
 *
 * Two properties matter more than the debounce itself:
 *
 *  - Saves never overlap. A change landing while a save is in flight is queued
 *    behind it rather than started alongside it, because two concurrent writes
 *    can complete out of order and silently resurrect an older draft.
 *  - A failure is surfaced, not swallowed, and the change stays pending so the
 *    next edit retries it. Losing someone's writing quietly is the worst thing
 *    a writing tool can do.
 */
export function useAutosave<T>({
  value,
  onSave,
  delayMs = 1500,
}: UseAutosaveOptions<T>): UseAutosaveResult {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const queued = useRef(false);
  /** Newest value, so a queued save writes the latest copy, not a stale one. */
  const latest = useRef(value);
  const lastSaved = useRef(value);
  const onSaveRef = useRef(onSave);
  const delayRef = useRef(delayMs);

  latest.current = value;
  onSaveRef.current = onSave;
  delayRef.current = delayMs;

  const flushRef = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flushRef.current();
    }, delayRef.current);
  }, []);

  const flush = useCallback(async () => {
    if (inFlight.current) {
      // Do not start a second write; remember that more work arrived.
      queued.current = true;
      return;
    }
    const pending = latest.current;
    if (Object.is(pending, lastSaved.current)) return;

    inFlight.current = true;
    if (mounted.current) setStatus('saving');

    try {
      await onSaveRef.current(pending);
      lastSaved.current = pending;
      if (mounted.current) {
        setStatus('saved');
        setSavedAt(new Date());
        setError(null);
      }
    } catch (err) {
      // lastSaved is deliberately left alone, so the change stays unsaved and
      // the next edit retries it.
      if (mounted.current) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.current = false;
      const hadQueuedWork = queued.current;
      queued.current = false;
      if (mounted.current && hadQueuedWork && !Object.is(latest.current, lastSaved.current)) {
        setStatus('pending');
        schedule();
      }
    }
  }, [schedule]);

  flushRef.current = flush;

  useEffect(() => {
    if (Object.is(value, lastSaved.current)) return;
    setStatus('pending');
    schedule();
  }, [value, delayMs, schedule]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const saveNow = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await flush();
  }, [flush]);

  return { status, savedAt, error, saveNow };
}
