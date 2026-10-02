/**
 * A community library before it is connected: what it is, what it covers,
 * what to know about trusting it — then one action. Connecting registers it
 * as a community library, fetches it, and opens it. Nothing changes until
 * then, and nothing is sent anywhere.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BackLink } from "../../components/BackLink";
import { Button, ErrorNotice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { api, HabiError, newJobId } from "../../lib/api";
import type { CommunityLibrary } from "../../lib/community";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, keys, useSources } from "../../lib/queries";

export function CommunityPreview({ library }: { library: CommunityLibrary }) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const sources = useSources();
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const connected = (sources.data ?? []).find(
    (s) => s.location.toLowerCase().replace(/\.git$/, "") === library.url.toLowerCase(),
  );

  const connect = async () => {
    setError(null);
    const id = newJobId();
    setJob(id);
    let registered: string | null = null;
    try {
      const added = await api.addSource({
        name: library.name,
        location: library.url,
        subdir: null,
        tracked: { kind: "default" },
      });
      registered = added.id;
      await api.setSourceRole(added.id, "community");
      void client.invalidateQueries({ queryKey: keys.sources });
      await api.refreshSource(added.id, id);
      invalidateProjectData(client);
      navigate({ name: "sources", sourceId: added.id });
    } catch (e) {
      // A library that could not be fetched is not left half-connected.
      if (registered) await api.removeSource(registered).catch(() => undefined);
      invalidateProjectData(client);
      setError(e);
    } finally {
      setJob(null);
    }
  };

  const cancelled = error instanceof HabiError && error.code === "cancelled";

  return (
    <div className="page narrow preview-page">
      <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />
      <header className="community-head">
        <p className="kicker">Community library</p>
        <h1 className="page-title">
          <Strand dye={{ color: "var(--ink-muted)", community: true }} size={22} /> {library.name}
        </h1>
        <p className="preview-repo mono">{library.repo}</p>
      </header>
      <p className="preview-summary">{library.summary}</p>
      <dl className="skill-facts preview-facts">
        <dt>Covers</dt>
        <dd>{library.topics.join(" · ")}</dd>
        <dt>Size</dt>
        <dd>about {library.skills} skills when Habi listed it</dd>
        <dt>Licence</dt>
        <dd>{library.note}</dd>
        <dt>Trust</dt>
        <dd>
          Published by its authors, not reviewed by your team. Agents follow a skill's instructions and may
          run the scripts it ships — read before you use one.
        </dd>
      </dl>
      {error && !cancelled ? <ErrorNotice error={error} title="Not connected" /> : null}
      {cancelled ? <p className="muted">Fetching was cancelled. Nothing was kept.</p> : null}
      <div className="preview-actions">
        {job ? (
          <Working onCancel={() => void api.cancelJob(job)}>Fetching {library.repo}…</Working>
        ) : connected ? (
          <Button variant="primary" onClick={() => navigate({ name: "sources", sourceId: connected.id })}>
            Open {connected.name}
          </Button>
        ) : (
          <>
            <Button variant="primary" icon="download" onClick={() => void connect()}>
              Connect library
            </Button>
            <button type="button" className="link-quiet" onClick={() => void api.openExternal(library.url)}>
              View on GitHub
            </button>
          </>
        )}
      </div>
      {!connected && !job ? (
        <p className="field-hint">
          Connecting copies the repository into Habi's cache with your Git setup. It never changes your
          projects; its skills are listed, not recommended, until someone adds rules.
        </p>
      ) : null}
    </div>
  );
}
