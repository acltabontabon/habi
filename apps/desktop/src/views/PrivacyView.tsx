/**
 * What stays on this machine, what leaves it, and what Habi will never do on its own. Every line
 * restates docs/project/security-model.md; when the model changes (or a new network path is added:
 * the updater, source/git.rs, catalog/github.rs, contribute.rs), this page changes with it.
 */
import { BackLink } from "../components/BackLink";
import { Mark } from "../components/Icon";
import { SECURITY, SECURITY_MODEL } from "../lib/links";
import { useOpenExternal } from "../lib/safeInvoke";

type Fact = [lead: string, detail: string];

/** What never leaves: each is a thread that stops short of the boundary. */
const STAYS: Fact[] = [
  ["Your project files", "Read here, matched here"],
  ["Library contents", "Kept on disk, read here"],
  ["Inspection and matching", "Nothing is sent away to be analyzed"],
  ["Logs and reports", "Redacted. A report is written only when you save it"],
];

/** What crosses, and only on these occasions: a trigger on this side, a destination on the other. */
const CROSSES: [from: Fact, to: Fact][] = [
  [
    ["Checking for updates", "Automatically, or when you ask"],
    ["GitHub releases", "One small file, nothing about you"],
  ],
  [
    ["Connecting or refreshing a library", "With your own Git setup"],
    ["That library’s repository", "A Git fetch"],
  ],
  [
    ["Opening a catalog library", "One you have not connected yet"],
    ["GitHub’s public API", "Stars and activity. Anonymous, kept for a day"],
  ],
  [
    ["Sharing a skill", "Only when you share"],
    ["Your remote", "A branch with the files you previewed"],
  ],
];

const SECRETS: Fact[] = [
  [
    "Credentials",
    "Habi stores no tokens. Sign-in goes through your own Git, gh and glab, and a source address carrying a password is refused.",
  ],
  ["Sharing", "A contribution is scanned for private keys and tokens, and blocked if any are found."],
];

const NEVER: Fact[] = [
  [
    "Code from libraries or projects",
    "Matching, previewing and refreshing never run their scripts, hooks or commands.",
  ],
  [
    "Checks",
    "Run only after you have seen the exact command, and the preview says plainly it is not sandboxed.",
  ],
  ["MCP servers", "Never started or contacted. “Configured” means an entry exists."],
  ["Git hooks and filters", "Switched off. Libraries are read as bare repositories, never checked out."],
];

const WRITES: Fact[] = [
  [
    "Preview first",
    "Every change to a project is shown, then applied atomically and journaled, so it can be restored.",
  ],
  [
    "Inside the project",
    "Symbolic links and .git paths are refused. Habi removes only files it wrote that are still unchanged.",
  ],
];

const SHELL: Fact[] = [
  [
    "The window",
    "The interface has no file, shell or network access of its own. Folders are chosen in native dialogs, and only https links open.",
  ],
  ["Library text", "Skill Markdown is sanitized and raw HTML is dropped."],
];

function Facts({ items }: { items: Fact[] }) {
  return (
    <dl className="facts">
      {items.map(([lead, detail]) => (
        <div key={lead}>
          <dt>{lead}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

const SECURITY_GROUPS: [title: string, items: Fact[]][] = [
  ["Never on its own", NEVER],
  ["Before anything is written", WRITES],
  ["Credentials and secrets", SECRETS],
  ["The app itself", SHELL],
];

function Line({ lead, detail }: { lead: string; detail: string }) {
  return (
    <>
      <strong>{lead}</strong>
      <span>{detail}</span>
    </>
  );
}

/** The boundary, drawn: threads that stop short of it, and the four that cross. */
function Boundary() {
  return (
    <div className="boundary">
      <div className="b-head" aria-hidden="true">
        <span className="b-side">
          <Mark size={16} />
          This machine
        </span>
        <span />
        <span className="b-side">Elsewhere</span>
      </div>
      <span className="b-axis" aria-hidden="true" />
      <ul className="b-rows">
        {STAYS.map(([lead, detail], i) => (
          <li key={lead} className="b-row is-stays" style={{ ["--i" as string]: i }}>
            <div className="b-from">
              <Line lead={lead} detail={detail} />
            </div>
            <span className="b-thread" aria-hidden="true">
              <i className="b-line" />
              <i className="b-cap" />
            </span>
            <div className="b-to">
              <span className="visually-hidden">Stays on this machine</span>
            </div>
          </li>
        ))}
        {CROSSES.map(([from, to], i) => (
          <li key={from[0]} className="b-row is-crosses" style={{ ["--i" as string]: STAYS.length + i }}>
            <div className="b-from">
              <Line lead={from[0]} detail={from[1]} />
            </div>
            <span className="b-thread" aria-hidden="true">
              <i className="b-line" />
              <i className="b-knot" />
            </span>
            <div className="b-to">
              <Line lead={to[0]} detail={to[1]} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PrivacyView() {
  const openExternal = useOpenExternal();
  return (
    <div className="page privacy-page">
      <BackLink fallback={{ name: "welcome" }} fallbackLabel="Home" />
      <h1 className="page-title">Privacy and security</h1>

      <section className="privacy-block" aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="privacy-group-title">
          Privacy
        </h2>
        <p className="privacy-lede">Everything stays here, except what crosses the line below.</p>
        <Boundary />
      </section>

      <section className="privacy-block" aria-labelledby="security-h">
        <h2 id="security-h" className="privacy-group-title">
          Security
        </h2>
        <p className="privacy-lede">
          Libraries, repositories and even Habi’s own window are treated as untrusted.
        </p>
        <div className="sec-groups">
          {SECURITY_GROUPS.map(([title, items]) => (
            <section key={title} className="sec-group" aria-label={title}>
              <h3 className="sec-title">{title}</h3>
              <Facts items={items} />
            </section>
          ))}
        </div>
      </section>

      <p className="privacy-foot">
        Habi has not had an independent security audit.{" "}
        <button type="button" className="link-quiet" onClick={() => openExternal(SECURITY_MODEL)}>
          Read the full security model
        </button>
        {" · "}
        <button type="button" className="link-quiet" onClick={() => openExternal(SECURITY)}>
          Report a vulnerability
        </button>
      </p>
    </div>
  );
}
