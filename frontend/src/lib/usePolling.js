import { useCallback, useEffect, useRef, useState } from "react";

// Calls `fetcher` now and then every `intervalMs`. Pauses while the browser tab
// is hidden, so a forgotten tab doesn't keep calling the API.
export function usePolling(fetcher, deps = [], intervalMs = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer;
    let cancelled = false;
    setLoading(true);
    setData(null);

    const tick = async () => {
      if (!document.hidden) await run();
      if (!cancelled && intervalMs) timer = setTimeout(tick, intervalMs);
    };
    const onVisible = () => { if (!document.hidden) run(); };

    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, run]);

  return { data, error, loading, updatedAt, refresh: run };
}
