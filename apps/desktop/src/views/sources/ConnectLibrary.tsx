/**
 * Connect your own library: a Git repository by URL, or a folder on this
 * machine. A name derived from the address, whose library it is, and what to
 * read and follow under options. Habi uses the Git credentials already set up
 * on this machine.
 *
 * On a page, the form sits beside a thread that says what Habi will do, drawn
 * only from what has been typed: where from, what is read, which version is
 * followed, and what it becomes. Each knot lights when it is true. In a dialog
 * there is no room for it, so the form stands alone with its hints.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { ImportCandidate } from "../../bindings/ImportCandidate";
import type { ImportInspection } from "../../bindings/ImportInspection";
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

const WHOSE: { kind: SourceRole; label: string; gist: string }[] = [
  { kind: "team", label: "Your team's", gist: "You maintain it, or review it where it is maintained." },
  { kind: "community", label: "Community", gist: "Published by others, and not reviewed by your team." },
];

type Track = "default" | "release" | "branch" | "tag";

const TRACKS: { kind: Track; label: string; title: string; gist: string }[] = [
  {
    kind: "default",
    label: "Default",
    title: "Default branch",
    gist: "The newest commit of the default branch.",
  },
  {
    kind: "release",
    label: "Latest release",
    title: "Latest release",
    gist: "The newest version tag, such as v1.4.0. The default branch until it has one.",
  },
  { kind: "branch", label: "A branch", title: "A branch", gist: "The newest commit of a branch you name." },
  { kind: "tag", label: "A tag", title: "A tag", gist: "One fixed tag. A tag that moves is flagged." },
];

/** A choice among a few, as one control: a pill each, the chosen one explained below. */
function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
  explain = true,
  hideLabel = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: { kind: T; label: string; gist: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Say what the chosen one means under the pills (a page has a panel for it instead). */
  explain?: boolean;
  /** Keep the label for screen readers only: the choice speaks for itself. */
  hideLabel?: boolean;
}) {
  const chosen = options.find((o) => o.kind === value);
  const label = useId();
  return (
    <div className="field choice-field" role="radiogroup" aria-labelledby={label}>
      <span className={hideLabel ? "visually-hidden" : "field-label"} id={label}>
        {legend}
      </span>
      <div className="choice">
        {options.map((o) => (
          <label key={o.kind} className="choice-pill">
            <input
              type="radio"
              name={name}
              checked={value === o.kind}
              disabled={disabled}
              onChange={() => onChange(o.kind)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {chosen && explain ? <span className="field-hint">{chosen.gist}</span> : null}
    </div>
  );
}

/** A word that is known is marked like highlighted text; one that is not yet is an open blank. */
function Tok({ known, children }: { known: boolean; children: React.ReactNode }) {
  return <span className={`tok${known ? "" : " is-open"}`}>{children}</span>;
}

/**
 * The whole form, said once in a sentence that is built from what has been
 * typed: where it is read from, what of it, which version, and what it
 * becomes. Blanks stay open until they are filled.
 */
function Sentence({
  mode,
  location,
  subdir,
  track,
  refName,
  name,
  role,
  onRename,
  canRename,
}: {
  mode: "git" | "folder";
  location: string;
  subdir: string;
  track: Track;
  refName: string;
  name: string;
  role: SourceRole;
  /** The name is edited where it is read: in the sentence. */
  onRename: (name: string) => void;
  canRename: boolean;
}) {
  const parts = locationParts(location);
  const where = parts ? (
    <Tok known>
      <span className="mono">{parts.repo}</span>
      {parts.host ? ` on ${parts.host}` : ""}
    </Tok>
  ) : (
    <Tok known={false}>{mode === "git" ? "a repository" : "a folder"}</Tok>
  );
  const only = subdir.trim() ? (
    <>
      , only <Tok known>{subdir.trim()}</Tok>,
    </>
  ) : null;
  const how =
    mode === "folder" ? (
      " in place"
    ) : track === "default" ? (
      <>
        {" "}
        at the newest commit of its <Tok known>default branch</Tok>
      </>
    ) : track === "release" ? (
      <>
        {" "}
        at its <Tok known>newest release</Tok>
      </>
    ) : track === "branch" ? (
      <>
        {" "}
        at the newest commit of <Tok known={Boolean(refName.trim())}>{refName.trim() || "a branch"}</Tok>
      </>
    ) : (
      <>
        {" "}
        at the tag <Tok known={Boolean(refName.trim())}>{refName.trim() || "a tag"}</Tok>
      </>
    );
  return (
    <p className="connect-sentence">
      Habi will read {where}
      {only}
      {how}, and list it as{" "}
      <input
        className={`tok tok-input${name.trim() ? "" : " is-open"}`}
        aria-label="Shown as"
        title="Click to rename"
        value={name}
        size={Math.max(9, name.length + 1)}
        placeholder="a library"
        spellCheck={false}
        disabled={!canRename}
        onChange={(e) => onRename(e.target.value)}
      />
      , a <Tok known>{role === "team" ? "team" : "community"}</Tok> library.
    </p>
  );
}

/** How an address is reached, in a few words. */
function transport(location: string): string {
  const text = location.trim();
  if (/^(ssh:\/\/|[^@/\s]+@[^/:\s]+:)/.test(text)) return "over SSH";
  if (text.startsWith("https://")) return "over HTTPS";
  if (text.startsWith("http://")) return "over HTTP";
  if (isLocalPath(text)) return "read from disk";
  return "";
}

/** What to give, before anything has been given: the shapes that work. */
function Guide() {
  const forms = [
    ["SSH", "git@github.com:team/skills.git"],
    ["HTTPS", "https://github.com/team/skills"],
    ["On this machine", "~/code/skills"],
  ];
  return (
    <div className="guide grow">
      <p className="guide-title kicker">Any of these will do</p>
      <dl className="guide-forms">
        {forms.map(([label, example]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{example}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The address, once given, as it was understood: where, which repository, how it is reached. */
function Address({ location }: { location: string }) {
  const parts = locationParts(location);
  if (!parts) return null;
  const how = transport(location);
  return (
    <div className="address grow">
      <span className="address-host">{parts.host ?? "this machine"}</span>
      <span className="address-repo mono">{parts.repo}</span>
      {how ? <span className="address-how">{how}</span> : null}
    </div>
  );
}

/** A note that takes the room a short column leaves, so the three stand level. */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel grow">
      <p className="panel-title kicker">{title}</p>
      {children}
    </div>
  );
}

/**
 * The chosen folder, opened: what Habi finds in it, read-only, before anything
 * is connected. A count, then each skill by name. It is the same reading the
 * library will do, so what is listed here is what will appear.
 */
function FolderScan({
  path,
  scan,
  onChoose,
  disabled,
}: {
  path: string;
  scan: { isPending: boolean; isError: boolean; error: unknown; data: ImportInspection | undefined };
  onChoose: () => void;
  disabled: boolean;
}) {
  const skills = scan.data?.candidates ?? [];
  const withScripts = skills.filter((c) => c.files.some((f) => f.startsWith("scripts/"))).length;
  const needLook = skills.filter((c) => !c.complete || c.problems.length > 0).length;
  return (
    <div className="scan">
      <div className="scan-head">
        <Icon name="folder" size={16} />
        <span className="scan-path mono" title={path}>
          <span className="scan-parent">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
          <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>
        </span>
        <button type="button" className="link-quiet" onClick={onChoose} disabled={disabled}>
          Choose another…
        </button>
      </div>
      {scan.isPending ? (
        <p className="scan-state" role="status">
          Looking inside…
        </p>
      ) : scan.isError ? (
        <p className="scan-state tone-warn" role="status">
          Could not look inside:{" "}
          {scan.error instanceof Error ? scan.error.message : "the folder is not readable."}
        </p>
      ) : skills.length === 0 ? (
        <div className="scan-state" role="status">
          <p className="scan-none">No skills in here</p>
          <p>{scan.data?.notes[0] ?? "No SKILL.md was found in this folder or the folders inside it."}</p>
          <p>Choose the folder that holds your skill folders.</p>
        </div>
      ) : (
        <>
          <p className="scan-figure" role="status">
            <span className="scan-count">{skills.length}</span>
            <span className="scan-label">{skills.length === 1 ? "skill" : "skills"} found</span>
            <span className="scan-marks">
              {withScripts > 0 ? <span>{plural(withScripts, "has", "have")} scripts</span> : null}
              {needLook > 0 ? <span className="tone-warn">{needLook} need a look</span> : null}
            </span>
          </p>
          <ul className="scan-list" aria-label="Skills found in the folder">
            {skills.map((c, i) => (
              <li
                key={c.path || c.name}
                className="scan-item"
                style={{ "--i": Math.min(i, 14) } as React.CSSProperties}
              >
                <span className="scan-name">{c.title || c.name}</span>
                <span className="scan-desc" title={c.description}>
                  {c.description}
                </span>
                <span className="scan-meta mono">{plural(c.files.length, "file")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Reading only a subfolder of a repository is occasional: a quiet link, and the field only when wanted. */
function Narrow({
  subdir,
  onChange,
  disabled,
}: {
  subdir: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open && !subdir) {
    return (
      <button
        type="button"
        className="link-quiet narrow-link"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        Only read a subfolder…
      </button>
    );
  }
  return (
    <label className="field">
      <span className="field-label">Only this subfolder</span>
      <input
        className="input mono"
        value={subdir}
        onChange={(e) => onChange(e.target.value)}
        placeholder="engineering/skills"
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: the field was just asked for
        autoFocus
        disabled={disabled}
      />
    </label>
  );
}

/** The most lines of a folder's tree that fit in its panel. */
const TREE_LINES = 9;

/**
 * The folder as Habi reads it: its skills, and what is in the first few.
 * Drawn from what the scan found, so it is this folder and no other.
 */
export function treeOf(root: string, skills: ImportCandidate[]): string[] {
  const lines = [`${root}/`];
  // A folder that is itself one skill has its files directly under it.
  if (skills.length === 1 && skills[0]?.path === "") {
    const entries = topEntries(skills[0].files);
    entries.slice(0, TREE_LINES - 2).forEach((e, i, all) => {
      lines.push(`${i === all.length - 1 && entries.length <= TREE_LINES - 2 ? "└─" : "├─"} ${e}`);
    });
    if (entries.length > TREE_LINES - 2) lines.push(`└─ … ${entries.length - (TREE_LINES - 2)} more`);
    return lines;
  }
  let budget = TREE_LINES - 1;
  let shown = 0;
  for (const [i, skill] of skills.entries()) {
    const kids = i < 2 ? topEntries(skill.files).slice(0, 2) : [];
    const need = 1 + kids.length;
    // Keep a line back for "and N more" while there are more to come.
    const reserve = i < skills.length - 1 ? 1 : 0;
    if (budget - need < reserve && shown > 0) break;
    const last = i === skills.length - 1;
    const name = skill.path.split("/").pop() || skill.name;
    lines.push(`${last ? "└─" : "├─"} ${name}/`);
    for (const [k, kid] of kids.entries()) {
      lines.push(`${last ? "   " : "│  "}${k === kids.length - 1 ? "└─" : "├─"} ${kid}`);
    }
    budget -= need;
    shown += 1;
  }
  if (shown < skills.length) lines.push(`└─ … ${skills.length - shown} more`);
  return lines;
}

/** The first level of a skill's files: SKILL.md first, then the rest, folders once. */
function topEntries(files: string[]): string[] {
  const seen = new Set<string>();
  for (const f of files) {
    const [head, ...rest] = f.split("/");
    if (head) seen.add(rest.length > 0 ? `${head}/` : head);
  }
  return [...seen].sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

/**
 * The choice, as what you would get: two tiles, each a piece of cloth in the
 * thread that kind of library has everywhere in Habi. Your team's is solid;
 * a community's is stitched, a reminder it is not reviewed. The chosen one is
 * lit. The tiles take the height of the column beside them.
 */
function WhoseTiles({
  role,
  onChange,
  disabled,
}: {
  role: SourceRole;
  onChange: (role: SourceRole) => void;
  disabled: boolean;
}) {
  const label = useId();
  return (
    <div className="tiles grow" role="radiogroup" aria-labelledby={label}>
      <span className="visually-hidden" id={label}>
        Whose library is this?
      </span>
      {WHOSE.map((w) => (
        <label key={w.kind} className={`tile${role === w.kind ? " is-chosen" : ""}`}>
          <input
            type="radio"
            name="role"
            aria-label={w.label}
            checked={role === w.kind}
            disabled={disabled}
            onChange={() => onChange(w.kind)}
          />
          <span className="cloth" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <span
                key={n}
                className={`cloth-thread${w.kind === "community" ? " is-stitched" : ""}${n === 3 ? " is-new" : ""}`}
              />
            ))}
          </span>
          <span className="tile-title">{w.label}</span>
          <span className="tile-gist">{w.gist}</span>
        </label>
      ))}
    </div>
  );
}

/** What counts as a skill: this folder's own tree once it has been read, else an example. */
function SkillTree({ root, skills }: { root: string; skills: ImportCandidate[] | undefined }) {
  if (skills && skills.length > 0) {
    const files = skills.reduce((n, s) => n + s.files.length, 0);
    return (
      <>
        <pre className="skill-tree mono">{treeOf(root, skills).join("\n")}</pre>
        <p className="panel-text">
          {plural(skills.length, "skill")}, {plural(files, "file")}. Anything beside a SKILL.md comes along.
        </p>
      </>
    );
  }
  return (
    <>
      <pre className="skill-tree mono" aria-hidden="true">
        {"my-skills/\n├─ review-pr/\n│  ├─ SKILL.md\n│  └─ scripts/\n└─ release-notes/\n   └─ SKILL.md"}
      </pre>
      <p className="panel-text">
        {skills ? "Nothing like this in the folder yet. " : ""}A folder with a SKILL.md. Anything beside it
        comes along.
      </p>
    </>
  );
}

const isLocalPath = (location: string) => location.trim().startsWith("/") || location.trim().startsWith("~");

export function ConnectLibrary({
  onConnected,
  onCancel,
  compact = false,
  mode = "git",
}: {
  onConnected: (source: Source, itemCount: number) => void;
  onCancel?: () => void;
  compact?: boolean;
  /** A Git repository (by URL) or a folder on this machine (picked). */
  mode?: "git" | "folder";
}) {
  const client = useQueryClient();
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [subdir, setSubdir] = useState("");
  const [trackKind, setTrackKind] = useState<Track>("default");
  const [refName, setRefName] = useState("");
  const [role, setRole] = useState<SourceRole>("team");
  const [registered, setRegisteredState] = useState<Source | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

  const isLocal = isLocalPath(location);
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
    jobRef.current = id;
    const fetched = api.refreshSource(source.id, id);
    fetching.current = fetched;
    try {
      const outcome = await fetched;
      // Fetched once: from here on it is a connected library, kept on leaving.
      registeredRef.current = null;
      invalidateProjectData(client);
      const library = await api.library(source.id);
      if (mounted.current) onConnected(outcome.source, library.items.length);
    } finally {
      jobRef.current = null;
      fetching.current = null;
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
          trackKind === "default"
            ? { kind: "default" }
            : trackKind === "release"
              ? { kind: "latestRelease" }
              : { kind: trackKind, name: refName.trim() };
        source = await api.addSource({
          name: shownName.trim(),
          location: location.trim(),
          subdir: subdir.trim() || null,
          tracked,
        });
        if (role === "community") source = await api.setSourceRole(source.id, "community");
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

  const named = trackKind === "branch" || trackKind === "tag";
  const valid = Boolean(location.trim() && shownName.trim() && (!named || refName.trim()));
  const cancelled = error instanceof HabiError && error.code === "cancelled";
  const locked = busy || Boolean(registered);
  // Folder page: look inside the chosen folder (read-only), so the box says what Habi will find.
  const [scanSub, setScanSub] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setScanSub(subdir.trim()), 350);
    return () => window.clearTimeout(t);
  }, [subdir]);
  const scanPath = location.trim() ? (scanSub ? `${location.trim()}/${scanSub}` : location.trim()) : "";
  const scan = useQuery({
    queryKey: ["folderScan", scanPath],
    queryFn: () => api.inspectImport({ type: "folder", path: scanPath }),
    enabled: mode === "folder" && !compact && Boolean(scanPath),
    retry: false,
    staleTime: 30_000,
  });
  const started = Boolean(location.trim());
  const optionsOpen = Boolean(subdir) || trackKind !== "default";

  /* The pieces, shared by the page (three stations) and the dialog (one column). */
  const where =
    mode === "folder" ? (
      <div className={`field${compact ? "" : " grow"}`}>
        {compact ? <span className="field-label">Folder</span> : null}
        {!compact && location ? (
          <FolderScan
            path={scanSub ? `${location}/${scanSub}` : location}
            scan={scan}
            onChoose={() => void chooseFolder()}
            disabled={busy}
          />
        ) : (
          <button
            type="button"
            className={`pick${location ? " is-chosen" : ""}`}
            onClick={() => void chooseFolder()}
            disabled={busy}
          >
            <Icon name="folder" size={18} />
            <span className="pick-text">
              {location ? (
                <span className="pick-path mono">{location}</span>
              ) : (
                <span className="pick-empty">Choose a folder…</span>
              )}
              <span className="pick-sub">
                {location ? "Choose another…" : "Skill folders in it become the library."}
              </span>
            </span>
          </button>
        )}
        {compact ? (
          <span className="field-hint">
            Habi reads skill folders from it and never writes there. Edits you make elsewhere show up when you
            update.
          </span>
        ) : null}
      </div>
    ) : (
      <div className="field">
        {compact ? (
          <label className="field-label" htmlFor="connect-location">
            Repository URL
          </label>
        ) : null}
        <input
          id="connect-location"
          className="input input-lg mono"
          aria-label="Repository URL"
          value={location}
          onChange={(e) => {
            setLocation(e.target.value);
            dropStale();
          }}
          placeholder="git@github.com:team/skills.git"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        {compact ? (
          <span className="field-hint">
            Read with the Git access you already have — your credential helper or SSH agent. Nothing in the
            repository is changed, and Habi never asks for a password.
          </span>
        ) : null}
      </div>
    );

  const subfolder = (
    <label className="field">
      <span className="field-label">Only this subfolder</span>
      <input
        className="input mono"
        value={subdir}
        onChange={(e) => setSubdir(e.target.value)}
        placeholder="engineering/skills"
        spellCheck={false}
        disabled={locked}
      />
    </label>
  );

  const follow =
    mode === "git" ? (
      <>
        <Choice
          legend="Follow"
          name="track"
          value={trackKind}
          options={TRACKS}
          onChange={setTrackKind}
          disabled={locked || isLocal}
          explain={compact}
        />
        {named ? (
          <input
            className="input mono"
            value={refName}
            onChange={(e) => setRefName(e.target.value)}
            placeholder={trackKind === "branch" ? "main" : "v1.4.0"}
            aria-label={`${trackKind} name`}
            disabled={locked}
          />
        ) : null}
      </>
    ) : null;

  const nameField = (
    <label className="field">
      <span className="field-label">Shown as</span>
      <input
        className="input"
        value={shownName}
        onChange={(e) => {
          setName(e.target.value);
          setNameEdited(true);
        }}
        placeholder="Named from where it comes from"
        disabled={locked}
      />
    </label>
  );

  const whose = (
    <Choice
      legend="Whose library is this?"
      name="role"
      value={role}
      options={WHOSE}
      onChange={setRole}
      disabled={locked}
      explain={compact}
      hideLabel={!compact}
    />
  );

  const problems = (
    <>
      {error && !cancelled ? (
        <ErrorNotice
          error={error}
          title={registered ? "The library could not be fetched" : "The library could not be connected"}
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
      {registered ? (
        <Button variant="quiet" onClick={() => void forget()}>
          Remove and start over
        </Button>
      ) : onCancel && compact ? (
        // A page has its back link; only a dialog needs a way out beside the button.
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </>
  );

  const submitOnEnter = (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && !busy) void submit();
  };

  /* A dialog has no room for stations: one column, the unusual choices folded away. */
  if (compact) {
    return (
      <form className="form connect connect-compact" onSubmit={submitOnEnter}>
        {where}
        {started ? nameField : null}
        {started ? whose : null}
        <details className="options" open={optionsOpen || undefined}>
          <summary>
            <Icon name="chevronRight" size={12} />
            Options
            <span className="options-now muted">
              {subdir.trim() ? `only ${subdir.trim()}` : "everything"}
              {mode === "git" ? ` · ${TRACKS.find((t) => t.kind === trackKind)?.label.toLowerCase()}` : ""}
            </span>
          </summary>
          <div className="options-body">
            {subfolder}
            {follow}
          </div>
        </details>
        {problems}
        <div className="form-actions">
          {job ? <Working onCancel={() => void api.cancelJob(job)}>Fetching {shownName}…</Working> : buttons}
        </div>
      </form>
    );
  }

  const stations: {
    key: string;
    title: string;
    lit: boolean;
    locked: boolean;
    body: React.ReactNode;
  }[] = [
    {
      key: "from",
      title: mode === "git" ? "Where is it kept?" : "Which folder?",
      lit: started,
      locked: false,
      body: (
        <>
          {where}
          {mode === "git" ? started ? <Address location={location} /> : <Guide /> : null}
        </>
      ),
    },
    {
      key: "reads",
      title: "How to read it",
      lit: started,
      locked: !started,
      body: (
        <>
          {follow}
          {mode === "git" ? <Narrow subdir={subdir} onChange={setSubdir} disabled={locked} /> : null}
          {mode === "folder" ? (
            <Panel
              title={
                scan.data && scan.data.candidates.length > 0
                  ? "What Habi will read"
                  : "What counts as a skill"
              }
            >
              <SkillTree
                root={
                  (scanSub ? `${location}/${scanSub}` : location).split("/").filter(Boolean).pop() ?? "folder"
                }
                skills={scan.data?.candidates}
              />
            </Panel>
          ) : (
            <Panel title={TRACKS.find((t) => t.kind === trackKind)?.title ?? "Follow"}>
              <p className="panel-text">{TRACKS.find((t) => t.kind === trackKind)?.gist}</p>
              <p className="panel-text">Each update is pinned to the exact commit it read.</p>
            </Panel>
          )}
        </>
      ),
    },
    {
      key: "becomes",
      title: "What it becomes",
      lit: valid,
      locked: !started,
      body: <WhoseTiles role={role} onChange={setRole} disabled={locked} />,
    },
  ];

  return (
    <form className="form connect connect-board" onSubmit={submitOnEnter}>
      <div className="stations">
        {stations.map((st, i) => (
          <fieldset
            key={st.key}
            className={`station${st.lit ? " is-lit" : ""}${st.locked ? " is-locked" : ""}${
              i === 0 && !started ? " is-next" : ""
            }`}
            disabled={st.locked || (i > 0 && busy)}
          >
            <legend className="visually-hidden">{st.title}</legend>
            <span className="station-knot" aria-hidden="true">
              {i + 1}
            </span>
            <h2 className="station-title">{st.title}</h2>
            <div className="station-body">{st.body}</div>
          </fieldset>
        ))}
      </div>

      {problems}

      <div className="connect-foot">
        <div className="connect-say">
          <Sentence
            mode={mode}
            location={location}
            subdir={subdir}
            track={trackKind}
            refName={refName}
            name={shownName}
            role={role}
            canRename={started && !locked}
            onRename={(v) => {
              setName(v);
              setNameEdited(true);
            }}
          />
        </div>
        {job ? null : <div className="connect-actions">{buttons}</div>}
      </div>

      {/* The loom is where connecting happens: waiting, then weaving. */}
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
    </form>
  );
}
