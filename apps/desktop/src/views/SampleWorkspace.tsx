/**
 * The sample workspace: example libraries and projects, all labeled. It is
 * made from the start screen or the palette, and removed from the banner in
 * its projects and libraries, from Settings or from the palette. Removing it
 * touches nothing of the user's own.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Dialog } from "../components/Dialog";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Notice } from "../components/ui";
import { api } from "../lib/api";
import { useNav } from "../lib/nav";
import { modShortcut } from "../lib/platform";
import { invalidateProjectData, keys, useRecentProjects, useSources } from "../lib/queries";

/** Makes (or makes again) the sample workspace and opens its first project. */
export function useCreateSample() {
  const { navigate } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const create = useCallback(async () => {
    setBusy(true);
    try {
      const sample = await api.createSampleWorkspace();
      invalidateProjectData(client);
      void client.invalidateQueries({ queryKey: keys.recent });
      toast.show("Sample workspace ready. Everything in it is example data.");
      const first = sample.projects[0];
      if (first) navigate({ name: "project", projectId: first.id, tab: "recommendations" });
    } catch (e) {
      toast.show(
        `The sample workspace was not created: ${e instanceof Error ? e.message : String(e)}`,
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }, [client, navigate, toast]);
  return { create, busy };
}

/** Whether any sample library or project is present. */
export function useHasSample(): boolean {
  const sources = useSources();
  const recent = useRecentProjects();
  return (sources.data ?? []).some((s) => s.sample) || (recent.data ?? []).some((p) => p.sample);
}

export function RemoveSampleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeSampleWorkspace();
      onOpenChange(false);
      // Leave the sample screens first, so nothing asks for what is gone.
      navigate({ name: "welcome" });
      void client.invalidateQueries();
      toast.show("Sample workspace removed. Your own projects and libraries were not changed.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title="Remove the sample workspace?"
      description="This removes the example libraries and projects. Your own projects, libraries and skills are not touched."
      footer={
        <>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>
            Remove sample workspace
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorNotice error={error} title="The sample workspace was not removed" />
      ) : (
        <p className="muted">
          You can try it again at any time from the command palette ({modShortcut("K")}).
        </p>
      )}
    </Dialog>
  );
}

/** Shown in sample projects and sample libraries, for as long as they are there. */
export function SampleBanner() {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Notice
        tone="unknown"
        title="You're looking at sample data."
        action={
          <Button size="sm" onClick={() => setConfirm(true)}>
            Remove sample workspace
          </Button>
        }
      >
        Sample libraries are matched only with sample projects.
      </Notice>
      <RemoveSampleDialog open={confirm} onOpenChange={setConfirm} />
    </>
  );
}
