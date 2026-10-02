/**
 * Conservative scheduled refresh: only while the window is visible and the
 * machine reports a network, at most once per configured interval per
 * source. Refresh only fetches library content; it never changes projects.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, newJobId } from "./api";
import { invalidateProjectData } from "./queries";

const CHECK_EVERY_MS = 15 * 60 * 1000;

export function useScheduledRefresh() {
  const client = useQueryClient();
  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      try {
        const settings = await api.getSettings();
        if (settings.autoRefreshHours === 0) return;
        const due = Date.now() - settings.autoRefreshHours * 3600 * 1000;
        const sources = await api.listSources();
        let refreshed = false;
        for (const source of sources) {
          const last = source.lastAttemptAt ? Date.parse(source.lastAttemptAt) : 0;
          if (source.freshness !== "neverFetched" && last < due) {
            await api.refreshSource(source.id, newJobId()).catch(() => undefined);
            refreshed = true;
          }
        }
        if (refreshed) invalidateProjectData(client);
      } catch {
        // A background refresh never interrupts; each library shows its own
        // freshness, and the next tick tries again.
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void tick(), CHECK_EVERY_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client]);
}
