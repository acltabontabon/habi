/**
 * Connect a team library: the repository URL (or a folder) first, a derived
 * name, and everything else — subfolder, branch or tag — under advanced
 * options. Habi uses the Git credentials already set up on this machine.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Source } from "../../bindings/Source";
import type { TrackedRef } from "../../bindings/TrackedRef";
import { Button, ErrorNotice, Working } from "../../components/ui";
import { api, HabiError, newJobId } from "../../lib/api";
import { invalidateProjectData, keys } from "../../lib/queries";

/** "git@github.com:acme/team-skills.git" -> "team-skills". */
export function nameFromLocation(location: string): string {
  const last = location
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[\\/:]/)
    .filter(Boolean)
    .pop();
  return (last ?? "").replace(/\.git$/, "");
}

export function ConnectLibrary({
  onConnected,
  onCancel,
  compact = false,
}: {
  onConnected: (source: Source, itemCount: number) => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const client = useQueryClient();
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [subdir, setSubdir] = useState("");
  const [trackKind, setTrackKind] = useState<"default" | "branch" | "tag">("default");
  const [refName, setRefName] = useState("");
  const [registered, setRegistered] = useState<Source | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const isLocal = location.trim().startsWith("/") || location.trim().startsWith("~");
  const shownName = nameEdited ? name : nameFromLocation(location);

  // A library registered by an attempt whose fetch failed belongs to the old
  // address. Editing the address unregisters it, so trying again does not
  // leave a second, broken library behind.
  const dropStale = () => {
    if (!registered) return;
    const stale = registered;
    setRegistered(null);
    api
      .removeSource(stale.id)
      .then(() => invalidateProjectData(client))
      .catch((e: unknown) => setError(e));
  };

  const chooseFolder = async () => {
    try {
      const folder = await api.pickLibraryFolder();
      if (folder) {
        setLocation(folder);
        dropStale();
      }
    } catch (e) {
      setError(e);
    }
  };

  const fetchLibrary = async (source: Source) => {
    const id = newJobId();
    setJob(id);
    try {
      const outcome = await api.refreshSource(source.id, id);
      invalidateProjectData(client);
      const library = await api.library(source.id);
      onConnected(outcome.source, library.items.length);
    } finally {
      setJob(null);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      let source = registered;
      if (!source) {
        const tracked: TrackedRef =
          trackKind === "default" ? { kind: "default" } : { kind: trackKind, name: refName.trim() };
        source = await api.addSource({
          name: shownName.trim(),
          location: location.trim(),
          subdir: subdir.trim() || null,
          tracked,
        });
        setRegistered(source);
        void client.invalidateQueries({ queryKey: keys.sources });
      }
      await fetchLibrary(source);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!registered) return;
    try {
      await api.removeSource(registered.id);
      invalidateProjectData(client);
    } catch (e) {
      setError(e);
      return;
    }
    setRegistered(null);
    setError(null);
  };

  const valid = Boolean(location.trim() && shownName.trim() && (trackKind === "default" || refName.trim()));
  const cancelled = error instanceof HabiError && error.code === "cancelled";

  return (
    <form
      className={`form connect${compact ? " connect-compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor="connect-location">
          Repository URL
        </label>
        <div className="input-row">
          <input
            id="connect-location"
            className="input mono"
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              dropStale();
            }}
            placeholder="git@github.com:your-team/skills.git"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          <Button icon="folder" onClick={() => void chooseFolder()} disabled={busy}>
            Use a folder…
          </Button>
        </div>
        <span className="field-hint">
          {isLocal
            ? "A folder on this machine. Connecting and refreshing only read it."
            : "Read with the Git access you already have. Nothing in the repository is changed."}
        </span>
      </div>

      {location.trim() ? (
        <label className="field">
          <span className="field-label">Shown as</span>
          <input
            className="input"
            value={shownName}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            disabled={busy || Boolean(registered)}
          />
        </label>
      ) : null}

      <details className="advanced" open={Boolean(subdir) || trackKind !== "default" || undefined}>
        <summary>Advanced options</summary>
        <div className="advanced-body">
          <label className="field">
            <span className="field-label">Only this subfolder</span>
            <input
              className="input mono"
              value={subdir}
              onChange={(e) => setSubdir(e.target.value)}
              placeholder="engineering/skills"
              spellCheck={false}
              disabled={busy || Boolean(registered)}
            />
          </label>
          <fieldset className="field" disabled={busy || Boolean(registered) || isLocal}>
            <legend className="field-label">Follow</legend>
            <div className="segmented">
              {(["default", "branch", "tag"] as const).map((k) => (
                <label key={k} className="radio">
                  <input
                    type="radio"
                    name="track"
                    checked={trackKind === k}
                    onChange={() => setTrackKind(k)}
                  />
                  {k === "default" ? "The default branch" : k === "branch" ? "A branch" : "A tag"}
                </label>
              ))}
            </div>
            {trackKind !== "default" ? (
              <input
                className="input mono"
                value={refName}
                onChange={(e) => setRefName(e.target.value)}
                placeholder={trackKind === "branch" ? "main" : "v1.4.0"}
                aria-label={`${trackKind} name`}
              />
            ) : null}
            <span className="field-hint">
              Whatever you follow, each refresh is pinned to the exact commit it fetched.
            </span>
          </fieldset>
        </div>
      </details>

      {error && !cancelled ? (
        <ErrorNotice
          error={error}
          title={registered ? "The library could not be fetched" : "The library could not be connected"}
        />
      ) : null}
      {cancelled ? <p className="muted">Fetching was cancelled. Nothing was downloaded.</p> : null}

      <div className="form-actions">
        {job ? (
          <Working onCancel={() => void api.cancelJob(job)}>Fetching {shownName}…</Working>
        ) : (
          <>
            <Button variant="primary" type="submit" busy={busy} disabled={!valid}>
              {registered ? "Try again" : "Connect library"}
            </Button>
            {registered ? (
              <Button variant="quiet" onClick={() => void forget()}>
                Remove and start over
              </Button>
            ) : onCancel ? (
              <Button variant="quiet" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </>
        )}
      </div>
    </form>
  );
}
