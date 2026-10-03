/**
 * The welcome: what Habi is for, in three threads, and whether this machine has
 * what Habi leans on. It opens when Habi starts until the person turns it off;
 * a missing Git is also kept in view on the home page, because without it
 * libraries cannot be pulled. Nothing here is a settings form: the one choice
 * is whether to see it again.
 */
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { AgentReach } from "../components/AgentReach";
import { Mark } from "../components/Icon";
import { keepOpenForToasts } from "../components/Toasts";
import { ToolInstall } from "../components/ToolInstall";
import { ToolThread } from "../components/ToolThread";
import { Button, Status } from "../components/ui";
import { ALL_CLIENTS } from "../lib/format";
import { headlineParts, pickHeadline } from "../lib/headlines";
import { keys, useAppInfo, useSettings } from "../lib/queries";
import { isFound, TOOLS, type ToolFact } from "../lib/tools";

const THREADS = [
  {
    verb: "Find",
    rest: "what applies",
    gist: "Open a project and Habi matches it to the skills your libraries hold.",
  },
  {
    verb: "Improve",
    rest: "what works",
    gist: "Write a skill from what you learned, and keep your own versions.",
  },
  { verb: "Share", rest: "what you learn", gist: "Offer a better version to a library for review." },
];

/** What inspection reads (docs/library-authors/detectors.md), named the way people name their stack. */
const STACKS = [
  { name: "Java", reads: "Maven and Gradle: pom.xml, build.gradle(.kts), version catalogs" },
  { name: "Kotlin", reads: "Gradle and Maven: build.gradle.kts, pom.xml, version catalogs" },
  { name: "JavaScript", reads: "package.json, package-lock.json and pnpm-lock.yaml" },
  { name: "TypeScript", reads: "package.json, tsconfig and the lockfiles" },
  { name: "Go", reads: "go.mod" },
  { name: "Rust", reads: "Cargo.toml and Cargo.lock" },
  { name: "Python", reads: "pyproject.toml, requirements, Pipfile; uv, Poetry and Pipenv lockfiles" },
  { name: "PHP", reads: "composer.json and composer.lock" },
  { name: "Monorepos", reads: "Module by module: every folder with a build manifest" },
];

export function WelcomeOverlay({ onClose }: { onClose: (hideNext: boolean) => void }) {
  const settings = useSettings();
  const initiallyHidden = settings.data?.showWelcome === false;
  // Follows the saved setting until the person touches the box.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const hideNext = chosen ?? initiallyHidden;
  // Chosen once per opening, so the headline does not change under the reader.
  const [headline] = useState(() => pickHeadline());
  const [before, emphasis, after] = headlineParts(headline);
  const close = () => onClose(hideNext);

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          className="welcome"
          aria-describedby="welcome-lead"
          onPointerDownOutside={keepOpenForToasts}
          // Focus the dialog itself, without scrolling: on a short window a focused button would scroll the story away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus({ preventScroll: true });
          }}
        >
          <div className="welcome-inner">
            <div className="welcome-grid">
              <section className="welcome-story">
                <p className="welcome-brand">
                  <Mark size={26} />
                  <span>Habi</span>
                </p>
                <RadixDialog.Title className="welcome-title">
                  {before}
                  {emphasis ? <em>{emphasis}</em> : null}
                  {after}
                </RadixDialog.Title>
                <p id="welcome-lead" className="welcome-lead">
                  {headline.sub}
                </p>
                <ol className="welcome-threads">
                  {THREADS.map((t, i) => (
                    <li key={t.verb} style={{ "--i": i } as CSSProperties}>
                      <span className="wt-knot" aria-hidden="true" />
                      <p className="wt-head">
                        <strong>{t.verb}</strong> {t.rest}
                      </p>
                      <p className="wt-gist">{t.gist}</p>
                    </li>
                  ))}
                </ol>
              </section>
              <Setup />
            </div>
            <footer className="welcome-foot">
              <label className="welcome-optout">
                <input type="checkbox" checked={hideNext} onChange={(e) => setChosen(e.target.checked)} />
                <span>Don’t show this again</span>
              </label>
              <Button variant="primary" onClick={close}>
                Get started
              </Button>
            </footer>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * What Habi works with. Git is the one thing it needs, so it is the one thing
 * checked here, next to the projects it reads and the agent tools it installs
 * for. The GitHub and GitLab CLIs only add pull and merge requests, and many
 * people use one host and never the other, so they are not asked for here:
 * Settings shows them, with how to add them.
 */
function Setup() {
  const info = useAppInfo();
  const client = useQueryClient();
  const data = info.data;
  if (!data) return null;
  const git = TOOLS.find((t) => t.key === "git") as ToolFact;
  const gitFound = isFound(data, "git");

  return (
    <section className="welcome-setup" aria-labelledby="welcome-setup-title">
      <header className="ws-head">
        <h2 id="welcome-setup-title" className="ws-title">
          Works with
        </h2>
        <p className={`ws-state${gitFound ? "" : " is-warn"}`} role="status">
          {gitFound ? "Ready to pull libraries." : "Git is needed to pull libraries."}
        </p>
      </header>
      <ul className="ws-tools">
        <li className={`ws-tool${gitFound ? " is-found" : " is-missing"}`}>
          <div className="ws-tool-head">
            <p className="ws-tool-name">{git.name}</p>
            <Status tone={gitFound ? "ok" : "warn"}>{gitFound ? "found" : "not found"}</Status>
          </div>
          <p className="ws-tool-purpose">{git.purpose}</p>
          <ToolThread key={String(gitFound)} found={gitFound} required index={0} />
          {gitFound ? null : (
            <>
              <ToolInstall tool={git} platform={data.platform} />
              <div className="ws-foot">
                <Button
                  size="sm"
                  icon="refresh"
                  busy={info.isFetching}
                  onClick={() => void client.invalidateQueries({ queryKey: keys.appInfo })}
                >
                  Check again
                </Button>
                <span className="ws-foot-hint">Still not found after installing? Restart Habi.</span>
              </div>
            </>
          )}
        </li>
        <li className="ws-tool">
          <div className="ws-tool-head">
            <p className="ws-tool-name">Projects</p>
          </div>
          <p className="ws-tool-purpose">
            Their stack, read from build files and lockfiles; nothing is built or run.
          </p>
          <ul className="reach" aria-label="Projects Habi reads">
            {STACKS.map((s) => (
              <li key={s.name} className="reach-agent is-on" data-tip={s.reads}>
                {s.name}
              </li>
            ))}
          </ul>
        </li>
        <li className="ws-tool">
          <div className="ws-tool-head">
            <p className="ws-tool-name">Agent tools</p>
          </div>
          <p className="ws-tool-purpose">Skills go where each one looks; you choose which, every time.</p>
          <AgentReach lit={ALL_CLIENTS} label="Installs for" />
        </li>
      </ul>
    </section>
  );
}
