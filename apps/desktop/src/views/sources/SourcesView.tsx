/**
 * Libraries: where knowledge comes from. The overview shows what is
 * connected, what can be discovered (a short curated list, previewed before
 * connecting), and how to bring in your own — a Git repository or a folder,
 * each with its own focused page. A connected library opens in LibraryView.
 */
import { BackLink } from "../../components/BackLink";
import { useToast } from "../../components/Toasts";
import { ErrorNotice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { COMMUNITY_LIBRARIES, catalogEntryFor } from "../../lib/community";
import { useDyes } from "../../lib/dye";
import { freshnessText, plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { useSources } from "../../lib/queries";
import { CommunityPreview } from "./CommunityPreview";
import { ConnectLibrary } from "./ConnectLibrary";
import { LibraryView } from "./LibraryView";
import { repositoryLabel } from "./SourceSheet";

/** Connect your own library: one intent per page. */
function ConnectOwn({ mode }: { mode: "git" | "folder" }) {
  const { navigate } = useNav();
  const toast = useToast();
  return (
    <div className="page narrow connect-page">
      <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />
      <p className="kicker">Your own library</p>
      <h1 className="page-title">
        {mode === "git" ? "Connect a Git repository" : "Use a folder as a library"}
      </h1>
      <p className="lead-sm">
        {mode === "git"
          ? "A repository of Agent Skills your team keeps. Habi reads it into its own cache and keeps it current when you refresh."
          : "Skill folders on this machine — a checkout, or your own collection. Habi reads them in place."}
      </p>
      <ConnectLibrary
        mode={mode}
        onCancel={() => navigate({ name: "sources" })}
        onConnected={(source, count) => {
          toast.show(`${source.name} connected: ${plural(count, "item")}.`);
          navigate({ name: "sources", sourceId: source.id });
        }}
      />
    </div>
  );
}

function LibrariesOverview() {
  const sources = useSources();
  const dyes = useDyes();
  const { navigate } = useNav();
  if (sources.isPending) return <Working>Loading libraries…</Working>;
  if (sources.isError) return <ErrorNotice error={sources.error} />;
  const connected = sources.data;
  const discoverable = COMMUNITY_LIBRARIES.filter(
    (c) => !connected.some((s) => catalogEntryFor(s.location)?.id === c.id),
  );
  const kind = (s: (typeof connected)[number]) =>
    s.role === "community"
      ? "community"
      : s.kind === "directory" || s.location.startsWith("/") || s.location.startsWith("~")
        ? "local"
        : "team";
  const order = { team: 0, local: 1, community: 2 } as const;

  return (
    <div className="page narrow libraries">
      <header className="libraries-head">
        <p className="kicker">Libraries</p>
        <h1 className="page-title">Where your knowledge comes from</h1>
        <p className="lead-sm">
          Skills your team keeps, collections the community publishes, and folders of your own — matched to
          your projects, improved where you work, shared back.
        </p>
      </header>

      {connected.length > 0 ? (
        <section className="libraries-section" aria-labelledby="lib-connected">
          <h2 id="lib-connected" className="kicker">
            Connected
          </h2>
          <ul className="library-rows">
            {[...connected]
              .sort((a, b) => order[kind(a)] - order[kind(b)] || a.name.localeCompare(b.name))
              .map((s) => {
                const fresh = freshnessText(s);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="library-row"
                      onClick={() => navigate({ name: "sources", sourceId: s.id })}
                    >
                      <Strand dye={dyes(s.id)} size={18} />
                      <span className="library-row-name">{s.name}</span>
                      <span className="library-row-repo">{repositoryLabel(s.location)}</span>
                      <span className="library-row-state">
                        {kind(s)}
                        <span
                          className={
                            fresh.tone === "muted" || fresh.tone === "ok" ? undefined : `tone-${fresh.tone}`
                          }
                        >
                          {" "}
                          · {fresh.text}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ) : null}

      {discoverable.length > 0 ? (
        <section className="libraries-section" aria-labelledby="lib-discover">
          <div className="libraries-section-head">
            <h2 id="lib-discover" className="kicker">
              Discover
            </h2>
            <span className="libraries-note">curated · published by others · not reviewed by your team</span>
          </div>
          <ul className="library-rows">
            {discoverable.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="library-row is-discover"
                  onClick={() => navigate({ name: "sources", sourceId: "community", itemId: c.id })}
                >
                  <Strand dye={{ color: "var(--ink-faint)", community: true }} size={18} />
                  <span className="library-row-name">{c.name}</span>
                  <span className="library-row-summary">{c.summary}</span>
                  <span className="library-row-state">about {c.skills} skills</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="libraries-section" aria-labelledby="lib-own">
        <h2 id="lib-own" className="kicker">
          Your own
        </h2>
        <ul className="library-rows">
          <li>
            <button
              type="button"
              className="library-row is-own"
              onClick={() => navigate({ name: "sources", sourceId: "git" })}
            >
              <span aria-hidden="true" />
              <span className="library-row-name">Connect a Git repository</span>
              <span className="library-row-summary">
                A team repository of skills, read with the Git access you already have.
              </span>
              <span className="library-row-state" aria-hidden="true">
                →
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="library-row is-own"
              onClick={() => navigate({ name: "sources", sourceId: "folder" })}
            >
              <span aria-hidden="true" />
              <span className="library-row-name">Use a folder on this machine</span>
              <span className="library-row-summary">A checkout or your own collection, read in place.</span>
              <span className="library-row-state" aria-hidden="true">
                →
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}

export function SourcesView({
  sourceId,
  itemId,
  file,
}: {
  sourceId?: string;
  itemId?: string;
  file?: string;
}) {
  const sources = useSources();
  if (sourceId === "git" || sourceId === "folder") return <ConnectOwn mode={sourceId} />;
  if (sourceId === "community") {
    const library = COMMUNITY_LIBRARIES.find((c) => c.id === itemId);
    if (library) return <CommunityPreview library={library} />;
  }
  const source = sources.data?.find((s) => s.id === sourceId);
  if (source) return <LibraryView key={source.id} source={source} itemId={itemId} file={file} />;
  return <LibrariesOverview />;
}
