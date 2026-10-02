/**
 * Fire-and-forget calls (open a link, reveal a folder) whose failure would
 * otherwise vanish: the failure is shown as a toast instead.
 */
import { useCallback } from "react";
import { useToast } from "../components/Toasts";
import { api } from "./api";

export function useSafeInvoke() {
  const toast = useToast();
  return useCallback(
    (call: () => Promise<unknown>, failure: string) => {
      call().catch((e: unknown) =>
        toast.show(`${failure}: ${e instanceof Error ? e.message : String(e)}`, "danger"),
      );
    },
    [toast],
  );
}

/** Opens an https link in the system browser, saying so when that fails. */
export function useOpenExternal() {
  const run = useSafeInvoke();
  return useCallback((url: string) => run(() => api.openExternal(url), "The link did not open"), [run]);
}
