/**
 * Where a library's knowledge comes from, on request: the repository, what
 * is followed, the revision, the last refresh and its latest change — and
 * the few things to do about it. Git is infrastructure behind the skills;
 * this is the only place it is spelled out.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Source } from "../../bindings/Source";
import type { SourceRole } from "../../bindings/SourceRole";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice } from "../../components/ui";
import { api, HabiError } from "../../lib/api";
import { relativeTime, shortId } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, useRefreshSource } from "../../lib/queries";

export function repositoryLabel(location: string): string {
  return location
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

function webUrl(location: string): string | null {
  if (location.startsWith("https://")) return location.replace(/\.git$/, "");
  const ssh = location.match(/^git@([^:]+):(.+?)(\.git)?$/);
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : null;
}

export function SourceSheet({ source, onClose }: { source: Source; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const { navigate } = useNav();
  const refresh = useRefreshSource();
  const [confirm, setConfirm] = useState(false);
  const web = webUrl(source.location);

  const doRefresh = () =>
    refresh.mutate(source.id, {
      onSuccess: (r) =>
        toast.show(
          r.changed
            ? `${source.name}: ${r.updated.length} updated, ${r.added.length} new, ${r.removed.length} removed. Installed copies were not changed.`
            : `${source.name} is up to date.`,
        ),
    });

  const setRole = async (role: SourceRole) => {
    try {
      await api.setSourceRole(source.id, role);
      invalidateProjectData(client);
    } catch (e) {
      toast.show(`Could not change ${source.name}: ${e instanceof Error ? e.message : String(e)}`, "danger");
    }
  };

  const disconnect = async () => {
    try {
      await api.removeSource(source.id);
    } catch (e) {
      toast.show(
        `Could not disconnect ${source.name}: ${e instanceof Error ? e.message : String(e)}`,
        "danger",
      );
      return;
    }
    invalidateProjectData(client);
    toast.show(`${source.name} disconnected. Installed content in projects was not changed.`);
    onClose();
    navigate({ name: "sources" });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={source.name}
      footer={
        confirm ? (
          <>
            <span className="muted sheet-confirm">
              Remove Habi's copy? Installed skills stay as they are.
            </span>
            <Button variant="quiet" onClick={() => setConfirm(false)}>
              Keep
            </Button>
            <Button variant="danger" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" icon="trash" onClick={() => setConfirm(true)}>
              Disconnect…
            </Button>
            <Button icon="refresh" busy={refresh.isPending} onClick={doRefresh}>
              {source.snapshot ? "Refresh" : "Fetch"}
            </Button>
          </>
        )
      }
    >
      <dl className="sheet-facts">
        <dt>Repository</dt>
        <dd className="mono">
          {repositoryLabel(source.location)}
          {source.subdir ? ` › ${source.subdir}` : ""}
          {web ? (
            <button type="button" className="link-quiet" onClick={() => void api.openExternal(web)}>
              open
            </button>
          ) : null}
        </dd>
        <dt>Follows</dt>
        <dd className="mono">
          {source.tracked.kind === "default"
            ? "default branch"
            : `${source.tracked.kind} ${source.tracked.name}`}
        </dd>
        <dt>Revision</dt>
        <dd className="mono">{source.snapshot ? shortId(source.snapshot) : "not fetched"}</dd>
        <dt>Refreshed</dt>
        <dd className="mono">{source.snapshotAt ? relativeTime(source.snapshotAt) : "never"}</dd>
        {source.commitSummary ? (
          <>
            <dt>Latest change</dt>
            <dd>{source.commitSummary}</dd>
          </>
        ) : null}
        <dt>Reviewed by</dt>
        <dd>
          <fieldset className="role-switch" aria-label="Whose library is this?">
            {(["team", "community"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={source.role === r}
                className={`role-option${source.role === r ? " is-active" : ""}`}
                onClick={() => (source.role === r ? undefined : void setRole(r))}
              >
                {r === "team" ? "Your team" : "Its authors (community)"}
              </button>
            ))}
          </fieldset>
        </dd>
      </dl>
      {source.warning ? (
        <Notice tone="warn" title="Review before adopting updates">
          {source.warning}
        </Notice>
      ) : null}
      {source.lastError && source.freshness !== "current" ? (
        <ErrorNotice
          error={new HabiError(source.lastError)}
          title={source.snapshot ? "The last refresh failed — the cached copy is shown" : "Not fetched"}
        />
      ) : null}
      {refresh.isError ? (
        <ErrorNotice error={refresh.error} title="Refresh failed — the cached copy is kept" />
      ) : null}
    </Dialog>
  );
}
