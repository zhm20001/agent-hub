import { useCallback, useEffect, useRef, useState } from 'react';
import { createTaskPoller, readTaskJson } from '../lib/task-data.ts';

/** The key owns the response: data from a previous task is never returned. */
export function useTaskData<T>(key: string, url: string, delay: (value: T | undefined) => number | null) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: true });
  const delayRef = useRef(delay);
  delayRef.current = delay;
  const pollerRef = useRef<ReturnType<typeof createTaskPoller<T>> | null>(null);
  useEffect(() => {
    setState({ key, loading: true });
    const poller = createTaskPoller<T>({
      load: signal => readTaskJson<T>(url, signal),
      receive: data => setState({ key, data, loading: false }),
      failed: error => setState(previous => ({ ...previous, key, loading: false,
        error: error instanceof Error ? error.message : String(error) })),
      delay: value => delayRef.current(value),
    });
    pollerRef.current = poller;
    return () => { poller.stop(); if (pollerRef.current === poller) pollerRef.current = null; };
  }, [key, url]);
  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  return { ...(state.key === key ? state : { key, loading: true, data: undefined, error: undefined }), refresh };
}
