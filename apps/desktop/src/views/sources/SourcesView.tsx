/** Libraries: the list, connecting one, and each library's own view. */

import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { useDyes } from "../../lib/dye";
import { freshnessText, plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { useSources } from "../../lib/queries";
import { ConnectLibrary } from "./ConnectLibrary";
import { LibraryView } from "./LibraryView";
import { repositoryLabel } from "./SourceSheet";

function AddSource() {
  const { navigate } = useNav();
  const toast = useToast();
  return (
    <div className="page narrow connect-page">
      <p className="kicker">Libraries</p>
      <h1 className="page-title">Connect a library</h1>
      <p className="lead-sm">
        A Git repository of Agent Skills — your team's own, or one the community publishes. Habi reads it into
        its own cache and keeps it current when you refresh.
      </p>
      <ConnectLibrary
        onCancel={() => navigate({ name: "sources" })}
        onConnected={(source, count) => {
          toast.show(`${source.name} connected: ${plural(count, "item")} available.`);
          navigate({ name: "sources", sourceId: source.id });
        }}
      />
      <details className="advanced connect-help">
        <summary>What Habi reads and changes</summary>
        <div className="advanced-body prose-sm">
          <p>
            Habi fetches the repository into its own cache with the Git setup you already use — your
            credential helper or SSH agent. It never asks for or stores passwords, and it does not run
            anything from the library.
          </p>
          <p>
            Refreshing only updates the catalog. Skills installed in your projects change only when you review
            and accept an update.
          </p>
          <p>Do not paste tokens into the URL; Habi refuses URLs that contain credentials.</p>
        </div>
      </details>
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
  const dyes = useDyes();
  const { navigate } = useNav();
  if (sourceId === "new") return <AddSource />;
  if (sources.isPending) return <Working>Loading libraries…</Working>;
  if (sources.isError) return <ErrorNotice error={sources.error} />;
  const source = sources.data.find((s) => s.id === sourceId);
  if (source) return <LibraryView key={source.id} source={source} itemId={itemId} file={file} />;
  return (
    <div className="page narrow libraries">
      <header className="skills-head">
        <div>
          <p className="kicker">Libraries</p>
          <h1 className="page-title">Where your knowledge comes from</h1>
        </div>
        {sources.data.length > 0 ? (
          <div className="skills-actions">
            <Button icon="plus" onClick={() => navigate({ name: "sources", sourceId: "new" })}>
              Connect a library…
            </Button>
          </div>
        ) : null}
      </header>
      {sources.data.length === 0 ? (
        <Empty
          title="No library connected"
          action={
            <Button
              variant="primary"
              icon="library"
              onClick={() => navigate({ name: "sources", sourceId: "new" })}
            >
              Connect a library…
            </Button>
          }
        >
          Optional. Habi is useful with only a project and your own skills; a library adds what your team — or
          the community — has already written.
        </Empty>
      ) : (
        <ul className="library-rows">
          {sources.data.map((s) => {
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
                  <span className={`library-row-state tone-${fresh.tone}`}>
                    {s.role === "community" ? "community · " : ""}
                    {fresh.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
