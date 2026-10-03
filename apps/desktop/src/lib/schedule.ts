/**
 * Conservative scheduled checking: only while the window is visible and the
 * machine reports a network, at most once per configured interval per
 * source. A repository is only asked whether it has something newer: nothing
 * is downloaded, and no library moves until the user presses Update. A local
 * folder has no remote, so it is simply read again. Neither changes a project.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, newJobId } from "./api";
import { keys } from "./queries";

const CHECK_EVERY_MS = 15 * 60 * 1000;
/** Coming back to the window looks again at most this often. */
const ON_RETURN_EVERY_MS = 60 * 1000;

export function useScheduledRefresh() {
  const client = useQueryClient();
  useEffect(() => {
    let running = false;
    let lastRun = 0;
    const tick = async (minGap = 0) => {
      if (running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - lastRun < minGap) return;
      running = true;
      lastRun = Date.now();
      try {
        const settings = await api.getSettings();
        if (settings.autoRefreshHours === 0) return;
        const due = Date.now() - settings.autoRefreshHours * 3600 * 1000;
        const sources = await api.listSources();
        const checked = new Map(
          (await api.sourceUpdates()).map((u) => [u.sourceId, Date.parse(u.checkedAt)]),
        );
        let looked = false;
        /** Local folders whose skills changed when read again. */
        const reread: string[] = [];
        for (const source of sources) {
          if (source.freshness === "neverFetched") continue;
          if (source.kind === "git") {
            if ((checked.get(source.id) ?? 0) < due) {
              await api.checkSourceUpdate(source.id).catch(() => undefined);
              looked = true;
            }
          } else {
            const last = source.lastAttemptAt ? Date.parse(source.lastAttemptAt) : 0;
            if (last < due) {
              const outcome = await api.refreshSource(source.id, newJobId()).catch(() => undefined);
              looked = true;
              if (outcome?.changed) reread.push(source.id);
            }
          }
        }
        // Only what moved is asked for again: each library's freshness and offer of an update,
        // and the skills of a folder that changed (with the recommendations drawn from them).
        // A repository was only asked; nothing in it was downloaded.
        if (looked) {
          void client.invalidateQueries({ queryKey: keys.sources });
          void client.invalidateQueries({ queryKey: keys.sourceUpdates });
        }
        for (const id of reread) {
          void client.invalidateQueries({ queryKey: keys.library(id) });
          void client.invalidateQueries({ queryKey: ["item", id] });
          void client.invalidateQueries({ queryKey: keys.updateReport(id) });
        }
        if (reread.length > 0) void client.invalidateQueries({ queryKey: ["overview"] });
      } catch {
        // A background refresh never interrupts; each library shows its own
        // freshness, and the next tick tries again.
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void tick(), CHECK_EVERY_MS);
    const onVisible = () => void tick(ON_RETURN_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client]);
}
