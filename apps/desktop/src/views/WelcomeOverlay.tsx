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
import { Icon, Mark } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { ToolThread } from "../components/ToolThread";
import { Button, Status } from "../components/ui";
import { headlineParts, pickHeadline } from "../lib/headlines";
import { keys, useAppInfo, useSettings } from "../lib/queries";
import { useOpenExternal } from "../lib/safeInvoke";
import { installCommand, isFound, TOOLS, type ToolFact } from "../lib/tools";

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
                  Skills your team has written, matched to the project in front of you.
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
                <span className="welcome-optout-hint">Settings brings it back.</span>
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

/** What Habi leans on, read from this machine, with a way to fix what is missing. */
function Setup() {
  const info = useAppInfo();
  const client = useQueryClient();
  const data = info.data;
  if (!data) return null;
  const missing = TOOLS.filter((t) => !isFound(data, t.key));
  const gitMissing = missing.some((t) => t.key === "git");

  return (
    <section className="welcome-setup" aria-labelledby="welcome-setup-title">
      <header className="ws-head">
        <h2 id="welcome-setup-title" className="ws-title">
          Your setup
        </h2>
        <p className={`ws-state${gitMissing ? " is-warn" : ""}`} role="status">
          {gitMissing
            ? "Git is needed to pull libraries."
            : missing.length === 0
              ? "Everything is threaded."
              : "Ready to pull libraries."}
        </p>
      </header>
      <ul className="ws-tools">
        {TOOLS.map((tool, i) => (
          <Tool
            key={`${tool.key}:${isFound(data, tool.key)}`}
            tool={tool}
            index={i}
            found={isFound(data, tool.key)}
            platform={data.platform}
          />
        ))}
      </ul>
      {missing.length > 0 ? (
        <footer className="ws-foot">
          <Button
            size="sm"
            icon="refresh"
            busy={info.isFetching}
            onClick={() => void client.invalidateQueries({ queryKey: keys.appInfo })}
          >
            Check again
          </Button>
          <span className="ws-foot-hint">Still not found after installing? Restart Habi.</span>
        </footer>
      ) : null}
    </section>
  );
}

function Tool({
  tool,
  found,
  index,
  platform,
}: {
  tool: ToolFact;
  found: boolean;
  index: number;
  platform: string;
}) {
  const openExternal = useOpenExternal();
  const toast = useToast();
  const command = installCommand(tool.key, platform);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("Copied.");
    } catch {
      toast.show("Could not copy. Select the command and copy it.", "danger");
    }
  };

  return (
    <li className={`ws-tool${found ? " is-found" : " is-missing"}`}>
      <div className="ws-tool-head">
        <p className="ws-tool-name">
          {tool.name}
          {tool.required ? null : <span className="ws-optional">optional</span>}
        </p>
        <Status tone={found ? "ok" : tool.required ? "warn" : "muted"}>
          {found ? "found" : "not found"}
        </Status>
      </div>
      <p className="ws-tool-purpose">{tool.purpose}</p>
      <ToolThread found={found} required={tool.required} index={index} />
      {found ? null : (
        <div className="ws-fix">
          {command ? (
            <div className="ws-command">
              <code>{command}</code>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Copy ${command}`}
                onClick={() => void copy(command)}
              >
                <Icon name="file" size={14} />
              </button>
            </div>
          ) : null}
          <button type="button" className="link-quiet ws-link" onClick={() => openExternal(tool.url)}>
            {command ? "Other ways to install" : `Install ${tool.name}`}
            <Icon name="external" size={12} />
          </button>
          {tool.after ? (
            <p className="ws-after">
              Then sign in with <code>{tool.after}</code>.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
