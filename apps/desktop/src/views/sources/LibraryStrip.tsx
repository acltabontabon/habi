/**
 * What to know about a catalog library before relying on it, kept to one
 * quiet strip above the skill being read: who publishes it, what it is
 * licensed as, how much is in it, which revision was read. Two disclosures
 * hold the depth: Inspection (what Habi noticed in the files) and Source
 * (where it comes from and what was read). A thread at the right shows how
 * far the library has come into your work, lit only by what is true.
 *
 * Official, community and reviewed are three separate facts. Official is an
 * ownership check, and says so. Reviewed is only shown when Habi's catalog
 * records an inspection; today it says plainly that none was done.
 */
import { useState } from "react";
import type { CatalogEntry } from "../../bindings/CatalogEntry";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Source } from "../../bindings/Source";
import { BackLink } from "../../components/BackLink";
import { Icon } from "../../components/Icon";
import { ErrorNotice, Notice, Working } from "../../components/ui";
import { countSignals, licenseLabel, ownershipShort, shortCommit, signalFile } from "../../lib/catalog";
import { plural, relativeTime } from "../../lib/format";
import { useCheckUpdate, useSourceUpdates } from "../../lib/queries";
import { useOpenExternal } from "../../lib/safeInvoke";
import { DisconnectButton } from "./DisconnectButton";
import { SIGNALS_CAVEAT } from "./Signals";

type Panel = "inspection" | "source" | null;

/* ---------- How far the library has come ---------- */

function ProvenanceThread({
  entry,
  adopted,
}: {
  entry: CatalogEntry;
  /** Copies of its skills in My skills. */
  adopted: number;
}) {
  const connected = entry.availability === "connected";
  const steps = [
    { label: "connected", done: connected },
    { label: adopted > 0 ? `${adopted} adopted` : "adopted", done: adopted > 0 },
  ];
  return (
    <ol className="thread" aria-label="How far this library has come into your work">
      {steps.map((s) => (
        <li key={s.label} className={`thread-step${s.done ? " is-done" : ""}`}>
          <span className="thread-knot" aria-hidden="true" />
          <span className="thread-label mono">{s.label}</span>
          <span className="visually-hidden">{s.done ? " (yes)" : " (not yet)"}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Inspection ---------- */

function InspectionPanel({
  entry,
  items,
  onOpen,
}: {
  entry: CatalogEntry;
  items: LibraryItem[];
  onOpen: (item: LibraryItem, file: string | null) => void;
}) {
  const c = entry.contents;
  if (!c) return null;
  const flagged = items
    .map((item) => ({ item, first: item.signals.find((s) => s.severity === "caution") }))
    .filter((x): x is { item: LibraryItem; first: NonNullable<typeof x.first> } => x.first !== undefined);
  return (
    <div className="strip-panel" id="strip-inspection">
      <p className="strip-panel-lead">
        {plural(c.items, "skill")} read.{" "}
        {c.withScripts > 0
          ? `${c.withScripts} ship${c.withScripts === 1 ? "s" : ""} scripts (${plural(c.scriptFiles, "file")}) an agent could run once installed. `
          : "None ships scripts. "}
        {c.withReferences > 0
          ? `${c.withReferences} ${c.withReferences === 1 ? "has" : "have"} reference files`
          : "None has reference files"}
        {c.withAssets > 0 ? `, ${c.withAssets} bundled assets` : ""}.
      </p>
      <p className="strip-panel-lead">
        {c.cautionItems > 0
          ? `${plural(c.cautionItems, "skill")} carr${c.cautionItems === 1 ? "ies" : "y"} a caution signal`
          : "No skill carries a caution signal"}
        {c.noticeItems > 0 ? `; ${plural(c.noticeItems, "other")} carry notices` : ""}
        {c.unusable > 0 ? `; ${plural(c.unusable, "skill")} cannot be installed as published` : ""}.
      </p>
      {flagged.length > 0 ? (
        <ul className="strip-flagged">
          {flagged.slice(0, 8).map(({ item, first }) => (
            <li key={item.id}>
              <button
                type="button"
                className="strip-flagged-item"
                onClick={() => onOpen(item, signalFile(item, first))}
              >
                <span className="strip-flagged-name">{item.title}</span>
                <span className="strip-flagged-what">{first.summary}</span>
                <span className="strip-flagged-where mono">
                  {first.path}
                  {first.line ? `:${first.line}` : ""}
                </span>
              </button>
            </li>
          ))}
          {flagged.length > 8 ? (
            <li className="muted strip-flagged-more">
              …and {flagged.length - 8} more. Each skill lists its own.
            </li>
          ) : null}
        </ul>
      ) : null}
      <p className="muted">{SIGNALS_CAVEAT}</p>
    </div>
  );
}

/* ---------- Source ---------- */

function SourcePanel({ entry, source }: { entry: CatalogEntry; source: Source }) {
  const openExternal = useOpenExternal();
  const check = useCheckUpdate();
  const update = useSourceUpdates().data?.find((u) => u.sourceId === source.id);
  const f = entry.fetched;
  const reads = entry.include.length === 0 ? "the whole repository" : entry.include.join("  ·  ");
  return (
    <div className="strip-panel" id="strip-source">
      <dl className="strip-facts-list">
        <dt>Repository</dt>
        <dd>
          <button type="button" className="link-quiet mono" onClick={() => openExternal(entry.url)}>
            {entry.repo}
          </button>
        </dd>
        <dt>Publisher</dt>
        <dd>
          {entry.publisher.name}
          {entry.ownership ? (
            <span className="muted">
              {" "}
              · {entry.ownership.evidence} (checked {entry.ownership.checked})
            </span>
          ) : (
            <span className="muted"> · an independent maintainer</span>
          )}
        </dd>
        {entry.review ? (
          <>
            <dt>Reviewed</dt>
            <dd>
              {entry.review.scope}{" "}
              <span className="muted">
                · {entry.review.by}, {entry.review.date} at{" "}
              </span>
              <span className="mono">{shortCommit(entry.review.revision)}</span>
              {entry.review.current ? null : (
                <span className="tone-warn"> · the library has changed since</span>
              )}
            </dd>
          </>
        ) : null}
        <dt>Reads</dt>
        <dd className="mono">
          {reads}
          {entry.exclude.length > 0 ? <span className="muted"> · not {entry.exclude.join(", ")}</span> : null}
        </dd>
        {f ? (
          <>
            <dt>Version</dt>
            <dd>
              <span className="mono">
                {f.release ?? `${f.branch ?? "default branch"}@${shortCommit(f.snapshot)}`}
              </span>
              {f.release ? <span className="muted mono"> · {shortCommit(f.snapshot)}</span> : null}
              {!f.release && entry.followsReleases ? (
                <span className="muted"> · no release published yet</span>
              ) : null}
              {f.commitSummary ? <span className="muted"> · {f.commitSummary}</span> : null}
            </dd>
            <dt>Fetched</dt>
            <dd>
              {relativeTime(f.snapshotAt)}
              {f.freshness === "stale" ? <span className="tone-warn"> · the last check failed</span> : null}
            </dd>
          </>
        ) : null}
        {entry.notes.length > 0 ? (
          <>
            <dt>Notes</dt>
            <dd>
              <ul className="strip-notes">
                {entry.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {source.warning ? (
          <>
            <dt>Warning</dt>
            <dd className="tone-warn">{source.warning}</dd>
          </>
        ) : null}
      </dl>
      <div className="strip-panel-actions">
        {check.isPending ? (
          <Working>Asking {entry.repo} for newer versions…</Working>
        ) : (
          <>
            <button type="button" className="link-quiet" onClick={() => check.mutate(source.id)}>
              Check for updates
            </button>
            {update && !update.available ? (
              <span className="muted">Up to date as of {relativeTime(update.checkedAt)}.</span>
            ) : null}
          </>
        )}
      </div>
      {check.isError ? <ErrorNotice error={check.error} title="Could not check for updates" /> : null}
    </div>
  );
}

/* ---------- The strip ---------- */

export function LibraryStrip({
  entry,
  source,
  items,
  adopted,
  onOpen,
}: {
  entry: CatalogEntry;
  source: Source;
  items: LibraryItem[];
  adopted: number;
  /** Opens a skill, and one of its files when the signal names one. */
  onOpen: (item: LibraryItem, file: string | null) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const c = entry.contents;
  const f = entry.fetched;
  const cautions = items.reduce((n, i) => n + countSignals(i).caution, 0);
  const licence = licenseLabel(c?.license);
  const official = ownershipShort(entry);
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  return (
    <section className="library-strip" aria-label={`About ${entry.name}`}>
      {entry.status.state !== "active" ? (
        <Notice tone="warn" title={entry.status.state === "archived" ? "Archived" : "Deprecated"}>
          {entry.status.note ?? "The publisher no longer maintains it."}
        </Notice>
      ) : null}
      <div className="strip-top">
        <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />
        <DisconnectButton source={source} />
      </div>
      <p
        className="kicker strip-kicker"
        title={official ? `${entry.ownership?.evidence}. Ownership only, not a review.` : undefined}
      >
        {entry.publisher.kind === "builder" ? "From the builders" : "From the community"}
        {official ? <span className="strip-trust"> · {official}</span> : null}
      </p>
      <h2 className="strip-title">{entry.name}</h2>
      <p className="strip-facts">
        {licence ? <span>{licence}</span> : null}
        {c ? <span>{plural(c.items, "skill")}</span> : null}
        {f ? (
          <span className="mono" title={f.commitSummary ?? undefined}>
            {f.release ?? `${f.branch ?? "main"}@${shortCommit(f.snapshot)}`}
          </span>
        ) : null}
        {f?.updated ? <span>changed {relativeTime(f.updated)}</span> : null}
      </p>
      {entry.problem ? (
        <Notice tone="warn" title="Showing the copy fetched earlier">
          The last attempt to reach {entry.repo} failed: {entry.problem.message}
        </Notice>
      ) : null}
      <div className="strip-tools">
        <button
          type="button"
          className="sig-toggle"
          aria-expanded={panel === "inspection"}
          aria-controls="strip-inspection"
          onClick={() => toggle("inspection")}
        >
          Inspection
          {cautions > 0 ? <span className="sig-count mono is-caution">{cautions}</span> : null}
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          className="sig-toggle"
          aria-expanded={panel === "source"}
          aria-controls="strip-source"
          onClick={() => toggle("source")}
        >
          Source
          <Icon name="chevronDown" size={12} />
        </button>
        <ProvenanceThread entry={entry} adopted={adopted} />
      </div>
      {panel === "inspection" ? <InspectionPanel entry={entry} items={items} onOpen={onOpen} /> : null}
      {panel === "source" ? <SourcePanel entry={entry} source={source} /> : null}
    </section>
  );
}
