/**
 * Connect a library: one box that takes whatever names it (`owner/repo`, a
 * Git address, the web address of a branch or folder, or a folder on this
 * machine), and one sentence that says what Habi understood. The sentence is
 * the form: each thing it says is changed where it stands. Habi uses the Git
 * credentials already set up on this machine.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Source } from "../../bindings/Source";
import type { SourceRole } from "../../bindings/SourceRole";
import type { TrackedRef } from "../../bindings/TrackedRef";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Working } from "../../components/ui";
import { WaitingLoom, Weaving } from "../../components/Weaving";
import { api, HabiError, newJobId } from "../../lib/api";
import { plural } from "../../lib/format";
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

/** An address in the words a person would use: the host, and `owner/repo`. */
export function locationParts(location: string): { host: string | null; repo: string } | null {
  const text = location.trim().replace(/[\\/]+$/, "");
  if (!text) return null;
  if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:[\\/]/.test(text)) {
    return { host: null, repo: text };
  }
  // git@host:owner/repo.git, https://host/owner/repo.git, ssh://git@host/owner/repo
  const match = text.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i);
  if (!match) return { host: null, repo: text };
  return { host: match[1] ?? null, repo: (match[2] ?? "").replace(/\.git$/, "") };
}

type Track = "default" | "release" | "branch" | "tag";

const TRACKS: { kind: Track; label: string }[] = [
  { kind: "default", label: "the default branch" },
  { kind: "release", label: "the newest release" },
  { kind: "branch", label: "a branch" },
  { kind: "tag", label: "a tag" },
];

const ROLE_GIST: Record<SourceRole, string> = {
  team: "Team: you or your team review what goes in, and it can require skills.",
  community: "Community: published by others, and not reviewed by your team.",
};

function trackOf(tracked: TrackedRef): { kind: Track; name: string } {
  switch (tracked.kind) {
    case "default":
      return { kind: "default", name: "" };
    case "latestRelease":
      return { kind: "release", name: "" };
    case "branch":
    case "tag":
      return { kind: tracked.kind, name: tracked.name };
  }
}

/** A word that is known is marked like highlighted text; one that is not yet is an open blank. */
function Tok({ known, children }: { known: boolean; children: React.ReactNode }) {
  return <span className={`tok${known ? "" : " is-open"}`}>{children}</span>;
}

/** A word of the sentence you can write over: it looks like a field, with a pencil to say so. */
function Written({
  label,
  value,
  placeholder,
  locked,
  mono = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  locked: boolean;
  mono?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className={`tok-rename${locked ? " is-locked" : ""}`}>
      <input
        className={`tok tok-input${mono ? " mono" : ""}${value.trim() ? "" : " is-open"}`}
        aria-label={label}
        value={value}
        size={Math.max(placeholder.length, value.length + 1)}
        placeholder={placeholder}
        spellCheck={false}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
      />
      {locked ? null : <Icon name="pencil" size={14} />}
    </label>
  );
}

/** Refused in a way SSH might not be: a private repository answers "not found" over https. */
const refusedOverHttps = (error: unknown) =>
  error instanceof HabiError && (error.code === "gitAuthentication" || error.code === "gitNotFound");

const isLocalPath = (location: string) =>
  location.startsWith("/") || location.startsWith("~") || /^[A-Za-z]:[\\/]/.test(location);

export function ConnectLibrary({
  onConnected,
  onCancel,
  inDialog = false,
  initialLocation = "",
}: {
  /** `itemId` is the skill a pasted address pointed at, when it named one. */
  onConnected: (source: Source, itemCount: number, itemId?: string) => void;
  /** An address the person already typed elsewhere. */
  initialLocation?: string;
  onCancel?: () => void;
  /** In a dialog there is no room for the loom, and a way out sits beside the button. */
  inDialog?: boolean;
}) {
  const client = useQueryClient();
  const [text, setText] = useState(initialLocation);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  // What the person changed in the sentence. Until then it says what the address does.
  const [subdirEdit, setSubdirEdit] = useState<string | null>(null);
  const [trackEdit, setTrackEdit] = useState<{ kind: Track; name: string } | null>(null);
  const [roleEdit, setRoleEdit] = useState<SourceRole | null>(null);
  const [registered, setRegisteredState] = useState<Source | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The same repository over SSH, to offer when https is refused.
  const [overSsh, setOverSsh] = useState<string | null>(null);

  // Leaving cancels a running fetch and unregisters a library that was
  // never fetched, so a failed or abandoned connect leaves nothing behind.
  const mounted = useRef(true);
  const registeredRef = useRef<Source | null>(null);
  const jobRef = useRef<string | null>(null);
  const fetching = useRef<Promise<unknown> | null>(null);
  const setRegistered = (source: Source | null) => {
    registeredRef.current = source;
    setRegisteredState(source);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (jobRef.current) void api.cancelJob(jobRef.current);
      const settled = (fetching.current ?? Promise.resolve()).catch(() => undefined);
      void settled.then(async () => {
        const orphan = registeredRef.current;
        if (!orphan) return;
        registeredRef.current = null;
        await api.removeSource(orphan.id).catch(() => undefined);
        invalidateProjectData(client);
      });
    };
  }, [client]);

  // What the box holds is read once typing pauses: `owner/repo` and the
  // address of a page become the repository, and the branch and folder shown.
  const typed = text.trim();
  const [paused, setPaused] = useState(typed);
  useEffect(() => {
    const t = window.setTimeout(() => setPaused(typed), 350);
    return () => window.clearTimeout(t);
  }, [typed]);
  const read = useQuery({
    queryKey: ["readAddress", paused],
    queryFn: () => api.readAddress(paused),
    enabled: Boolean(paused),
    retry: false,
    staleTime: 60_000,
  });
  const understood = paused === typed && read.data ? read.data : null;

  const location = understood?.location ?? typed;
  const isLocal = isLocalPath(location);
  const from = understood ? trackOf(understood.tracked) : { kind: "default" as Track, name: "" };
  const track = isLocal ? { kind: "default" as Track, name: "" } : (trackEdit ?? from);
  const subdir = subdirEdit ?? understood?.subdir ?? "";
  const role: SourceRole = roleEdit ?? (isLocal ? "team" : "community");
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

  const address = (next: string) => {
    setText(next);
    // What was changed in the sentence belonged to the address it described.
    setSubdirEdit(null);
    setTrackEdit(null);
    dropStale();
  };

  const chooseFolder = async () => {
    try {
      const folder = await api.pickLibraryFolder();
      if (folder) address(folder);
    } catch (e) {
      setError(e);
    }
  };

  const fetchLibrary = async (source: Source, focus: string | null) => {
    const id = newJobId();
    setJob(id);
    jobRef.current = id;
    const fetched = api.refreshSource(source.id, id);
    fetching.current = fetched;
    try {
      const outcome = await fetched;
      // Fetched once: from here on it is a connected library, kept on leaving.
      registeredRef.current = null;
      invalidateProjectData(client);
      const library = await api.library(source.id);
      const pointed = focus ? library.items.find((i) => i.path === focus)?.id : undefined;
      if (mounted.current) onConnected(outcome.source, library.items.length, pointed);
    } finally {
      jobRef.current = null;
      fetching.current = null;
      setJob(null);
    }
  };

  const submit = async (retryAt?: string) => {
    setError(null);
    setBusy(true);
    try {
      let source = retryAt ? null : registered;
      if (retryAt && registered) {
        // The first address was refused: what it registered goes with it.
        setRegistered(null);
        await api.removeSource(registered.id);
      }
      // A page of a repository asks its host which words are the branch.
      const read = retryAt || !understood ? await api.readAddress(retryAt ?? typed) : understood;
      if (retryAt) setText(read.location);
      setOverSsh(read.alternative?.startsWith("git@") ? read.alternative : null);
      if (!source) {
        const local = isLocalPath(read.location);
        const followed = local || !trackEdit ? null : trackEdit;
        const tracked: TrackedRef = !followed
          ? local
            ? { kind: "default" }
            : read.tracked
          : followed.kind === "default"
            ? { kind: "default" }
            : followed.kind === "release"
              ? { kind: "latestRelease" }
              : { kind: followed.kind, name: followed.name.trim() };
        source = await api.addSource({
          name: nameEdited ? name.trim() : nameFromLocation(read.location).trim(),
          location: read.location,
          subdir: (subdirEdit ?? read.subdir ?? "").trim() || null,
          tracked,
        });
        const wanted = roleEdit ?? (local ? "team" : "community");
        if (source.role !== wanted) source = await api.setSourceRole(source.id, wanted);
        setRegistered(source);
        void client.invalidateQueries({ queryKey: keys.sources });
        if (!mounted.current) {
          // Left while it was being added: do not fetch, unregister it.
          setRegistered(null);
          await api.removeSource(source.id).catch(() => undefined);
          invalidateProjectData(client);
          return;
        }
      }
      await fetchLibrary(source, read.focus);
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

  const named = track.kind === "branch" || track.kind === "tag";
  const valid = Boolean(typed && shownName.trim() && (!named || track.name.trim()));
  const cancelled = error instanceof HabiError && error.code === "cancelled";
  const locked = busy || Boolean(registered);
  const started = Boolean(typed);

  // A folder is looked into, read-only, so the page says what Habi will find.
  const scanPath = isLocal && understood ? (subdir.trim() ? `${location}/${subdir.trim()}` : location) : "";
  const scan = useQuery({
    queryKey: ["folderScan", scanPath],
    queryFn: () => api.inspectImport({ type: "folder", path: scanPath }),
    enabled: Boolean(scanPath),
    retry: false,
    staleTime: 30_000,
  });
  const found = scan.data?.candidates.length;

  const parts = understood ? locationParts(understood.location) : null;
  const where = parts ? (
    <Tok known>
      <span className="mono">{parts.repo}</span>
      {parts.host ? ` on ${parts.host}` : ""}
    </Tok>
  ) : started ? (
    <Tok known>
      <span className="mono">{typed}</span>
    </Tok>
  ) : (
    <Tok known={false}>a repository or a folder</Tok>
  );
  const narrowing = subdirEdit !== null || Boolean(subdir);

  const sentence = (
    <p className="connect-sentence">
      Habi will read {where}
      {narrowing ? (
        <>
          , only{" "}
          <Written
            label="Only this folder"
            value={subdir}
            placeholder="a folder"
            locked={locked}
            mono
            onChange={setSubdirEdit}
          />
          {locked ? null : (
            <button
              type="button"
              className="tok-clear"
              aria-label="Read the whole repository"
              title="Read the whole repository"
              onClick={() => setSubdirEdit(understood?.subdir ? "" : null)}
            >
              <Icon name="close" size={12} />
            </button>
          )}
          ,
        </>
      ) : null}
      {isLocal ? (
        " in place"
      ) : (
        <>
          {" at "}
          <select
            className="tok tok-select"
            aria-label="Follow"
            value={track.kind}
            disabled={locked || !started}
            onChange={(e) => setTrackEdit({ kind: e.target.value as Track, name: "" })}
          >
            {TRACKS.map((t) => (
              <option key={t.kind} value={t.kind}>
                {t.label}
              </option>
            ))}
          </select>
          {named ? (
            <>
              {" "}
              <Written
                label={track.kind === "branch" ? "Branch name" : "Tag name"}
                value={track.name}
                placeholder={track.kind === "branch" ? "main" : "v1.4.0"}
                locked={locked}
                mono
                onChange={(v) => setTrackEdit({ kind: track.kind, name: v })}
              />
            </>
          ) : null}
        </>
      )}
      , and list it as{" "}
      <Written
        label="Shown as"
        value={shownName}
        placeholder="a library"
        locked={locked || !started}
        onChange={(v) => {
          setName(v);
          setNameEdited(true);
        }}
      />
      , a{" "}
      <select
        className="tok tok-select"
        aria-label="Whose library"
        value={role}
        disabled={locked || !started}
        onChange={(e) => setRoleEdit(e.target.value as SourceRole)}
      >
        <option value="team">team</option>
        <option value="community">community</option>
      </select>{" "}
      library.
    </p>
  );

  const notes = started ? (
    <p className="connect-note">
      {ROLE_GIST[role]}
      {isLocal && found !== undefined
        ? ` ${found === 0 ? "No SKILL.md found in it yet." : `${plural(found, "skill")} found.`}`
        : ""}
      {!narrowing && !isLocal && !locked ? (
        <>
          {" "}
          <button type="button" className="link-quiet" onClick={() => setSubdirEdit("")}>
            Only read a folder…
          </button>
        </>
      ) : null}
    </p>
  ) : (
    <p className="connect-note">
      Paste <span className="mono">owner/repo</span>, a Git address, or the address of a branch or folder on
      GitHub or GitLab. Habi reads it with the Git access you already have and changes nothing in it.
    </p>
  );

  const problems = (
    <>
      {error && !cancelled ? (
        <ErrorNotice
          error={error}
          title={registered ? "The library could not be fetched" : "The library could not be connected"}
          action={
            overSsh && refusedOverHttps(error) ? (
              <Button variant="quiet" onClick={() => void submit(overSsh)} disabled={busy}>
                Try over SSH
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {cancelled ? <p className="muted">Fetching was cancelled. Nothing was downloaded.</p> : null}
    </>
  );

  const buttons = (
    <>
      <Button variant="primary" size="md" className="connect-go" type="submit" busy={busy} disabled={!valid}>
        {registered ? "Try again" : "Connect library"}
      </Button>
      {/* A button that will not press says why. */}
      {started && !valid && !busy ? (
        <span className="field-hint">
          {shownName.trim() ? "Say which branch or tag." : "Give it a name."}
        </span>
      ) : null}
      {registered ? (
        <Button variant="quiet" onClick={() => void forget()}>
          Remove and start over
        </Button>
      ) : onCancel && inDialog ? (
        // A page has its back link; only a dialog needs a way out beside the button.
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </>
  );

  return (
    <form
      className={`form connect ${inDialog ? "connect-compact" : "connect-one"}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      <div className="connect-box">
        <input
          id="connect-location"
          className="input input-lg mono"
          aria-label="Library address"
          value={text}
          onChange={(e) => address(e.target.value)}
          placeholder="owner/repo, a Git address, or a folder"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        <Button icon="folder" onClick={() => void chooseFolder()} disabled={busy}>
          Choose folder…
        </Button>
      </div>
      <div className="connect-say">
        {sentence}
        {notes}
      </div>
      {problems}
      {job && inDialog ? (
        <Working onCancel={() => void api.cancelJob(job)}>Fetching {shownName}…</Working>
      ) : job ? null : (
        <div className="connect-actions">{buttons}</div>
      )}
      {/* On a page the loom is where connecting happens: waiting, then weaving. */}
      {inDialog ? null : (
        <div className="connect-loom lp-loom">
          {job ? (
            <Weaving
              slim
              label={`Reading ${shownName}… nothing is installed or run.`}
              hint="A large repository takes a minute the first time."
              onCancel={() => void api.cancelJob(job)}
            />
          ) : (
            <WaitingLoom slim fill />
          )}
        </div>
      )}
    </form>
  );
}
