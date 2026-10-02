/**
 * Evaluates the rules being edited against projects, as they are edited.
 *
 * This is the matcher's verdict on the *rules* — it says nothing about the
 * skill's quality or what an agent will do with it. Recalculation is
 * debounced; a newer request cancels the older job and stale results are
 * discarded.
 */
import { useEffect, useRef, useState } from "react";
import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { SkillPreview } from "../bindings/SkillPreview";
import { api, HabiError, newJobId } from "./api";

export type RulesPreview = { preview: SkillPreview | null; busy: boolean; error: unknown };

export function useRulesPreview(
  request: PreviewRequest | null,
  /** Changes whenever what `request` asks for changes. */
  requestKey: string,
  enabled = true,
): RulesPreview {
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0);
  const job = useRef<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestKey stands for the request's content.
  useEffect(() => {
    if (!requestRef.current || !enabled) return;
    const mine = ++sequence.current;
    const timer = window.setTimeout(() => {
      const current = requestRef.current;
      if (!current) return;
      // A newer request makes the running one obsolete.
      if (job.current) void api.cancelJob(job.current);
      const id = newJobId();
      job.current = id;
      setBusy(true);
      api
        .previewSkill(current, id)
        .then((result) => {
          if (mine !== sequence.current) return;
          setPreview(result);
          setError(null);
        })
        .catch((e) => {
          if (mine !== sequence.current) return;
          if (e instanceof HabiError && e.code === "cancelled") return;
          setError(e);
        })
        .finally(() => {
          if (job.current === id) job.current = null;
          if (mine === sequence.current) setBusy(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [requestKey, enabled]);

  useEffect(
    () => () => {
      sequence.current += 1;
      if (job.current) void api.cancelJob(job.current);
    },
    [],
  );

  return { preview, busy, error };
}
