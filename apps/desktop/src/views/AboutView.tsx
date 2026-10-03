/**
 * About Habi: which version this is, whether a newer one waits, what changed in each (from
 * CHANGELOG.md), who made it, and the one way to support the work.
 */
import { useEffect } from "react";
import { Icon, Mark } from "../components/Icon";
import { Markdown } from "../components/lazy";
import { Working } from "../components/ui";
import { AUTHOR, ISSUES, REPOSITORY, SUPPORT } from "../lib/links";
import { useAppInfo } from "../lib/queries";
import { RELEASES, type Release, releaseDate } from "../lib/release";
import { useOpenExternal } from "../lib/safeInvoke";
import { markVersionSeen, useUpdates } from "../lib/updates";
import { UpdateStatus } from "./UpdateStatus";

export function AboutView() {
  const info = useAppInfo();
  const { state } = useUpdates();
  const openExternal = useOpenExternal();
  const version = info.data?.version;

  // Looking at What's new is how the mark beside the version in the sidebar goes away.
  useEffect(() => {
    if (version) markVersionSeen(version);
  }, [version]);

  if (!version) return <Working>Loading…</Working>;

  const offered = state.phase === "available" || state.phase === "installing" || state.phase === "ready";
  const incoming = offered ? state.info : null;

  return (
    <div className="page about">
      <header className="about-head">
        <Mark size={52} />
        <div className="about-id">
          <h1 className="page-title">Habi</h1>
          <p className="about-tagline">Find what applies. Improve what works. Share what you learn.</p>
        </div>
        <div className="about-version">
          <UpdateStatus />
        </div>
      </header>

      <div className="about-body">
        <section className="about-notes" aria-labelledby="whatsnew">
          <h2 id="whatsnew" className="section-title">
            What's new
          </h2>
          <ol className="timeline">
            {incoming ? (
              <li className="timeline-entry is-incoming">
                <span className="timeline-knot" aria-hidden="true" />
                <div className="timeline-head">
                  <h3 className="timeline-version">{incoming.version}</h3>
                  <span className="timeline-meta">available to install</span>
                </div>
                {incoming.notes ? (
                  <Markdown text={incoming.notes} />
                ) : (
                  <p className="muted">This release has no notes.</p>
                )}
              </li>
            ) : null}
            {RELEASES.map((release, i) => (
              <ReleaseEntry
                key={release.version}
                release={release}
                current={release.version === version}
                open={i === 0}
              />
            ))}
            {RELEASES.length === 0 && !incoming ? (
              <li className="timeline-entry">
                <span className="timeline-knot" aria-hidden="true" />
                <p className="muted">Notes for each version appear here.</p>
              </li>
            ) : null}
          </ol>
        </section>

        <aside className="about-side" aria-label="The maker">
          <section className="about-card">
            <h2 className="section-title">Made by</h2>
            <p>
              Habi is built and maintained by one person,{" "}
              <button type="button" className="link-quiet" onClick={() => openExternal(AUTHOR.site)}>
                {AUTHOR.name}
              </button>
              .
            </p>
            <button type="button" className="support" onClick={() => openExternal(SUPPORT)}>
              <Icon name="coffee" size={18} />
              <span>
                <strong>Buy me a coffee</strong>
                <span className="muted">Keeps Habi going, and free.</span>
              </span>
            </button>
          </section>
          <ul className="about-links">
            <li>
              <button type="button" className="link-quiet" onClick={() => openExternal(REPOSITORY)}>
                Source code <span className="muted">· Apache-2.0</span>
              </button>
            </li>
            <li>
              <button type="button" className="link-quiet" onClick={() => openExternal(ISSUES)}>
                Report a problem or suggest something
              </button>
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}

/** One released version. The newest shows its notes; older ones stay folded until asked for. */
function ReleaseEntry({ release, current, open }: { release: Release; current: boolean; open: boolean }) {
  const head = (
    <div className="timeline-head">
      <h3 className="timeline-version">{release.version}</h3>
      <span className="timeline-meta">
        <time dateTime={release.date}>{releaseDate(release.date)}</time>
        {release.prerelease ? " · pre-release" : ""}
        {current ? " · you are here" : ""}
      </span>
    </div>
  );
  return (
    <li className={`timeline-entry${current ? " is-current" : ""}`}>
      <span className="timeline-knot" aria-hidden="true" />
      {open ? (
        <>
          {head}
          <Markdown text={release.markdown} />
        </>
      ) : (
        <details>
          <summary>{head}</summary>
          <Markdown text={release.markdown} />
        </details>
      )}
    </li>
  );
}
