/**
 * Updating a library is the user's act, and what it changed is shown, not
 * buried. Two small pieces for the library's header:
 *
 * - UpdateBar: a newer version exists. One line, one button; nothing has
 *   been downloaded or moved.
 * - ChangeReport: the last update, in words (v6.4.1 → v6.4.2, 2 new, 3
 *   changed) with the skills named. The same skills carry a mark in the
 *   index until the report is dismissed.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { ReportedSkill } from "../../bindings/ReportedSkill";
import type { Source } from "../../bindings/Source";
import type { SourceUpdate } from "../../bindings/SourceUpdate";
import type { SourceVersion } from "../../bindings/SourceVersion";
import type { UpdateReport } from "../../bindings/UpdateReport";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Working } from "../../components/ui";
import { api, newJobId } from "../../lib/api";
import { shortCommit } from "../../lib/catalog";
import { plural, relativeTime } from "../../lib/format";
import {
  invalidateProjectData,
  keys,
  useCheckUpdate,
  useSourceUpdates,
  useUpdateReport,
} from "../../lib/queries";

/** A version the way a person names it: a release, or a branch at a commit. */
export function VersionName({ version }: { version: SourceVersion }) {
  return (
    <span className="mono" title={version.commit}>
      {version.release ? version.label : `${version.label}@${shortCommit(version.commit)}`}
    </span>
  );
}

export function UpdateBar({
  update,
  busy,
  checking,
  onUpdate,
}: {
  update: SourceUpdate;
  busy: boolean;
  checking: boolean;
  onUpdate: () => void;
}) {
  const { latest, current } = update;
  return (
    <div className="strip-update" role="status">
      <span className="strip-update-knot" aria-hidden="true" />
      <p className="strip-update-text">
        {latest.release ? (
          <>
            <VersionName version={latest} /> is out.
          </>
        ) : (
          <>
            New commits on <VersionName version={latest} />.
          </>
        )}
        {current ? (
          <span className="muted">
            {" "}
            You are reading <VersionName version={current} />.
          </span>
        ) : null}
      </p>
      {busy ? (
        <Working>Updating…</Working>
      ) : (
        <Button variant="primary" size="sm" disabled={checking} onClick={onUpdate}>
          Update
        </Button>
      )}
    </div>
  );
}

/** Which skills an update touched, for the index to mark. */
export function changesOf(report: UpdateReport | null | undefined): Map<string, "new" | "changed"> {
  const marks = new Map<string, "new" | "changed">();
  for (const s of report?.updated ?? []) marks.set(s.id, "changed");
  for (const s of report?.added ?? []) marks.set(s.id, "new");
  return marks;
}

function Names({
  label,
  skills,
  items,
  onOpen,
}: {
  label: string;
  skills: ReportedSkill[];
  items: LibraryItem[];
  onOpen?: (item: LibraryItem) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <section className="change-names">
      <h3 className="kicker">
        {label} <span className="mono">{skills.length}</span>
      </h3>
      <ul>
        {skills.map((s) => {
          const item = onOpen ? items.find((i) => i.id === s.id) : undefined;
          return (
            <li key={s.id}>
              {item && onOpen ? (
                <button type="button" className="link-quiet" onClick={() => onOpen(item)}>
                  {s.title}
                </button>
              ) : (
                <span className={onOpen ? undefined : "is-gone"}>{s.title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ChangeReport({
  report,
  items,
  onOpen,
  onDismiss,
}: {
  report: UpdateReport;
  items: LibraryItem[];
  onOpen: (item: LibraryItem) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const counts = [
    report.added.length > 0 ? `${report.added.length} new` : null,
    report.updated.length > 0 ? `${report.updated.length} changed` : null,
    report.removed.length > 0 ? `${report.removed.length} removed` : null,
  ].filter(Boolean);
  const nothing = counts.length === 0;
  return (
    <div className="strip-changes">
      <div className="strip-changes-head">
        <button
          type="button"
          className="sig-toggle"
          aria-expanded={open}
          aria-controls="strip-changes-list"
          disabled={nothing}
          onClick={() => setOpen((o) => !o)}
        >
          Updated
          {report.from ? (
            <>
              {" "}
              <VersionName version={report.from} /> → <VersionName version={report.to} />
            </>
          ) : (
            <>
              {" "}
              to <VersionName version={report.to} />
            </>
          )}
          {nothing ? null : <Icon name="chevronDown" size={12} />}
        </button>
        <span className="strip-changes-counts">
          {nothing
            ? `No ${plural(0, "skill")} changed.`
            : counts.map((c, i) => (
                <span key={c} className={i === 0 && report.added.length > 0 ? "tone-thread" : undefined}>
                  {c}
                </span>
              ))}
        </span>
        <button type="button" className="link-quiet strip-changes-seen" onClick={onDismiss}>
          Mark as seen
        </button>
      </div>
      {open ? (
        <div className="strip-changes-list" id="strip-changes-list">
          <Names label="New" skills={report.added} items={items} onOpen={onOpen} />
          <Names label="Changed" skills={report.updated} items={items} onOpen={onOpen} />
          <Names label="Removed" skills={report.removed} items={items} />
        </div>
      ) : null}
    </div>
  );
}

/** Asking again is not worth it within this long of an answer. */
const ASK_AGAIN_AFTER_MS = 60 * 60 * 1000;

/**
 * Everything about moving a Git library forward, for its header: it asks
 * once on opening whether the repository has something newer (a small
 * request; a failure is silent), offers Update when it does, and after an
 * update says what changed until the user has read it.
 */
export function LibraryUpdates({
  source,
  items,
  onOpen,
}: {
  source: Source;
  items: LibraryItem[];
  onOpen: (item: LibraryItem) => void;
}) {
  const client = useQueryClient();
  const updates = useSourceUpdates();
  const report = useUpdateReport(source.id).data ?? null;
  const check = useCheckUpdate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [manual, setManual] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const update = updates.data?.find((u) => u.sourceId === source.id);
  const asked = useRef<string | null>(null);

  const visible = !source.preview && !source.sample && source.snapshot !== null;
  const eligible = source.kind === "git" && visible;
  const checkedAt = update ? Date.parse(update.checkedAt) : 0;
  const { mutate } = check;
  useEffect(() => {
    if (!eligible || updates.isPending || asked.current === source.id) return;
    asked.current = source.id;
    if (Date.now() - checkedAt > ASK_AGAIN_AFTER_MS) mutate(source.id);
  }, [eligible, updates.isPending, source.id, checkedAt, mutate]);

  const apply = async () => {
    setBusy(true);
    setManual(false);
    setError(null);
    setRefreshed(false);
    try {
      await api.refreshSource(source.id, newJobId());
      setRefreshed(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      invalidateProjectData(client);
      void client.invalidateQueries({ queryKey: keys.updateReport(source.id) });
    }
  };

  const dismiss = async () => {
    await api.dismissUpdateReport(source.id).catch(() => undefined);
    void client.invalidateQueries({ queryKey: keys.updateReport(source.id) });
  };

  if (!visible) return null;
  const available = update?.available ? update : null;
  return (
    <div className="library-updates">
      <div className="library-update-check">
        <Button
          size="sm"
          icon="refresh"
          busy={eligible ? check.isPending : busy}
          disabled={busy || check.isPending}
          onClick={() => {
            if (eligible) {
              setManual(true);
              check.mutate(source.id);
            } else {
              void apply();
            }
          }}
        >
          {eligible ? (check.isPending ? "Checking…" : "Check for updates") : "Refresh library"}
        </Button>
        <span role="status">
          {eligible
            ? check.isPending
              ? "Checking the library for updates…"
              : manual && check.isSuccess
                ? check.data?.available
                  ? "Update available"
                  : check.data
                    ? "Library is up to date"
                    : "No update information available"
                : update
                  ? `Last checked ${relativeTime(update.checkedAt)}`
                  : null
            : refreshed
              ? "Library refreshed"
              : null}
        </span>
      </div>
      {manual && check.isError ? (
        <ErrorNotice error={check.error} title="Could not check for updates — try again" />
      ) : null}
      {available ? (
        <UpdateBar update={available} busy={busy} checking={check.isPending} onUpdate={() => void apply()} />
      ) : null}
      {error ? <ErrorNotice error={error} title="Could not update" /> : null}
      {report ? (
        <ChangeReport report={report} items={items} onOpen={onOpen} onDismiss={() => void dismiss()} />
      ) : null}
    </div>
  );
}
