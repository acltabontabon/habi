/**
 * Everything that is behind what it came from, in one place: libraries with
 * something newer to fetch, and the copies in projects, on this machine and
 * in My skills that can follow a library Habi already reads. Each row leads
 * to the review it always had; nothing changes from this page alone.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CopiesBehind } from "../bindings/CopiesBehind";
import type { LibraryAhead } from "../bindings/LibraryAhead";
import { Button, Empty, ErrorNotice, Notice, Working } from "../components/ui";
import { api, newJobId } from "../lib/api";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { invalidateProjectData, usePendingUpdates } from "../lib/queries";
import { ReviewDialog } from "./review/ReviewDialog";

const short = (commit: string) => commit.slice(0, 10);

/** What a library reads now and what its remote has, as people name versions. */
function versions(row: LibraryAhead): string {
  const name = (v: { label: string; release: boolean; commit: string }) =>
    v.release ? v.label : `${v.label} ${short(v.commit)}`;
  return row.current ? `${name(row.current)} → ${name(row.latest)}` : name(row.latest);
}

function placeName(row: CopiesBehind): string {
  switch (row.place.kind) {
    case "project":
      return row.place.name;
    case "machine":
      return "This machine";
    case "mySkills":
      return "My skills";
  }
}

export function UpdatesView() {
  const pending = usePendingUpdates();
  const { navigate } = useNav();
  const client = useQueryClient();
  const [review, setReview] = useState<CopiesBehind | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const fetchLibrary = async (row: LibraryAhead) => {
    setError(null);
    setFetching(row.sourceId);
    try {
      await api.refreshSource(row.sourceId, newJobId());
    } catch (e) {
      setError(e);
    } finally {
      setFetching(null);
      invalidateProjectData(client);
    }
  };

  const data = pending.data;
  const nothing = data && data.libraries.length === 0 && data.copies.length === 0;

  return (
    <div className="page updates">
      <header className="page-head">
        <h1 className="page-title">Updates</h1>
        <p className="lead-sm">What has moved on since you got it. Nothing changes until you review it.</p>
      </header>
      {pending.isPending ? <Working>Looking at what is installed…</Working> : null}
      {pending.isError ? <ErrorNotice error={pending.error} title="Updates could not be read" /> : null}
      {error ? <ErrorNotice error={error} title="The library could not be fetched" /> : null}
      {(data?.unreadable ?? []).map((p) => (
        <Notice
          key={p.id}
          tone="warn"
          title={`${p.name}: what is installed there could not be read`}
          action={
            <Button
              variant="quiet"
              onClick={() => navigate({ name: "project", projectId: p.id, tab: "workbench" })}
            >
              Open project
            </Button>
          }
        >
          {p.reason}
        </Notice>
      ))}
      {nothing ? (
        <Empty title="Everything is up to date">
          Libraries are checked when you open them and on the schedule in Settings.
        </Empty>
      ) : null}

      {data && data.libraries.length > 0 ? (
        <section aria-labelledby="updates-libraries">
          <h2 className="kicker" id="updates-libraries">
            Libraries with something newer
          </h2>
          <ul className="mach-rows">
            {data.libraries.map((row) => (
              <li className="mach-item" key={row.sourceId}>
                <div className="mach-main">
                  <span className="mach-title">{row.name}</span>
                  <span className="mys-purpose mono">{versions(row)}</span>
                </div>
                <span className="mach-acts">
                  <Button
                    icon="download"
                    busy={fetching === row.sourceId}
                    disabled={fetching !== null}
                    onClick={() => void fetchLibrary(row)}
                  >
                    Get update
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data && data.copies.length > 0 ? (
        <section aria-labelledby="updates-copies">
          <h2 className="kicker" id="updates-copies">
            Installed copies that can follow
          </h2>
          <ul className="mach-rows">
            {data.copies.map((row) => (
              <li className="mach-item" key={`${row.place.kind}:${placeName(row)}:${row.library}`}>
                <div className="mach-main">
                  <span className="mach-title">
                    {placeName(row)}
                    <span className="mach-tag">
                      {plural(row.keys.length, "item")} from {row.library}
                    </span>
                  </span>
                  <span className="mys-purpose">{row.titles.join(", ")}</span>
                </div>
                <span className="mach-acts">
                  {row.place.kind === "mySkills" ? (
                    // An editable copy is merged file by file, in the skill's own review.
                    <Button onClick={() => navigate({ name: "skills", skillId: row.keys[0] })}>
                      Open {row.titles.length === 1 ? "it" : "the first"}
                    </Button>
                  ) : (
                    <Button icon="refresh" onClick={() => setReview(row)}>
                      Update…
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {review ? (
        <ReviewDialog
          projectId={review.place.kind === "project" ? review.place.id : null}
          request={{
            kind: "update",
            keys: review.keys,
            title: `${plural(review.keys.length, "item")} from ${review.library}`,
          }}
          onClose={() => setReview(null)}
          onApplied={() => invalidateProjectData(client)}
        />
      ) : null}
    </div>
  );
}
