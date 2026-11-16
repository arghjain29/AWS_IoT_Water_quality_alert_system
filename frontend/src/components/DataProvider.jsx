// Shared data that several pages need:
//  * thresholds  - fetched once (single source: config/thresholds.json via the API)
//  * summary     - polled every 5 s ONCE for the whole app (sidebar badge, dashboard, stations)
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { POLL_MS } from "@/lib/config";
import { usePolling } from "@/lib/usePolling";

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [thresholds, setThresholds] = useState(null);
  const summary = usePolling(() => api.summary(), [], POLL_MS);

  useEffect(() => {
    api.thresholds().then((t) => setThresholds(t.parameters)).catch(() => setThresholds(null));
  }, []);

  return <DataContext.Provider value={{ thresholds, summary }}>{children}</DataContext.Provider>;
}

export function useAppData() {
  return useContext(DataContext);
}
