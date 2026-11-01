/**
 * What's inside a skill, in the order an agent meets it. Sizes are estimates and
 * say so. Other skills stand apart and are never added to the total, because
 * whether they load at all is up to the agent.
 */
import type { Composition } from "../../../../bindings/Composition";
import { Icon } from "../../../../components/Icon";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const tokens = (n: number) => `about ${fmt(n)} tokens`;

const LONG_INSTRUCTIONS = 5000;

type Stage = {
  key: string;
  name: string;
  when: string;
  size: number;
  rows?: { label: string; note?: string; onClick?: () => void }[];
};

function Bar({ value, max }: { value: number; max: number }) {
  const share = max > 0 ? Math.max(0.012, value / max) : 0;
  return (
    <span className="inside-bar" aria-hidden="true">
      <span style={{ transform: `scaleX(${share})` }} />
    </span>
  );
}

export function Inside({
  composition,
  titleOf,
  liveInstructionsTokens,
  ready,
  problems,
  onOpenFile,
  onWhen,
  onReadiness,
  onSource,
  onClose,
}: {
  composition: Composition | undefined;
  titleOf: (name: string) => string;
  /** The instructions as they are on the page, ahead of the last save. */
  liveInstructionsTokens: number;
  ready: boolean;
  problems: number;
  onOpenFile: (path: string) => void;
  onWhen: () => void;
  onReadiness: () => void;
  onSource: () => void;
  onClose: () => void;
}) {
  const context = composition?.context;
  const files = context?.files ?? [];
  const reading = files.filter((f) => f.kind === "reference" || f.kind === "example" || f.kind === "other");
  const scripts = files.filter((f) => f.kind === "script");
  const assets = files.filter((f) => f.kind === "asset");
  const sum = (list: typeof files) => list.reduce((n, f) => n + (f.tokens ?? 0), 0);
  const stages: Stage[] = [
    {
      key: "always",
      name: "Always in view",
      when: "An agent sees its name and purpose before choosing it.",
      size: context?.discoveryTokens ?? 0,
    },
    {
      key: "used",
      name: "Once it's chosen",
      when: "The instructions you're writing.",
      size: liveInstructionsTokens,
    },
    {
      key: "reading",
      name: "Read if needed",
      when: "References and examples wait until the instructions call for them.",
      size: sum(reading),
      rows: reading.map((f) => ({
        label: f.path,
        note: f.tokens === null ? undefined : tokens(f.tokens),
        onClick: () => onOpenFile(f.path),
      })),
    },
    {
      key: "scripts",
      name: "Scripts and tools",
      when: "Supporting files an agent may inspect or run, depending on the instructions and its permissions. Habi never runs them.",
      size: sum(scripts),
      rows: scripts.map((f) => ({
        label: f.path,
        note: f.tokens === null ? undefined : tokens(f.tokens),
        onClick: () => onOpenFile(f.path),
      })),
    },
  ];
  const max = Math.max(1, ...stages.map((s) => s.size));
  const deps = composition?.dependencies ?? [];
  const mentioned = composition?.mentioned ?? [];
  return (
    <aside className="inside" aria-label="What's inside this skill">
      <header className="shelf-head">
        <h2>What's inside</h2>
        <button type="button" className="shelf-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      <ol className="inside-stages">
        {stages.map((s) => (
          <li key={s.key} className="inside-stage">
            <div className="inside-stage-head">
              <h3>{s.name}</h3>
              <span className="inside-size">{s.size ? tokens(s.size) : "nothing yet"}</span>
            </div>
            <Bar value={s.size} max={max} />
            <p>{s.when}</p>
            {s.rows?.length ? (
              <ul className="inside-rows">
                {s.rows.map((r) => (
                  <li key={r.label}>
                    <button type="button" onClick={r.onClick}>
                      <span>{r.label}</span>
                      {r.note ? <em>{r.note}</em> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {s.key === "used" && s.size > LONG_INSTRUCTIONS ? (
              <p className="inside-hint">
                That's a lot to hold at once. Moving detail into a reference file keeps it out of the way
                until it's needed.
              </p>
            ) : null}
          </li>
        ))}
        {assets.length ? (
          <li className="inside-stage">
            <div className="inside-stage-head">
              <h3>Other files</h3>
            </div>
            <ul className="inside-rows">
              {assets.map((f) => (
                <li key={f.path}>
                  <button type="button" onClick={() => onOpenFile(f.path)}>
                    <span>{f.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ol>

      <section className="inside-others">
        <div className="inside-stage-head">
          <h3>Other skills</h3>
        </div>
        <p>
          {deps.length
            ? "Each has its own size, and loads only if the agent chooses to use it. That's why they aren't added up here."
            : "None linked yet."}
        </p>
        {deps.length ? (
          <ul className="inside-rows is-plain">
            {deps.map((d) => (
              <li key={d.name} className={d.status === "missing" ? "is-ghost" : undefined}>
                {titleOf(d.name)}
                {d.status === "missing" ? <em>not found here</em> : d.optional ? <em>optional</em> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {mentioned.length ? (
          <p className="inside-hint">
            {mentioned.length === 1 ? "One more is" : `${mentioned.length} more are`} only mentioned in the
            words: {mentioned.map((m) => titleOf(m.name)).join(", ")}.
          </p>
        ) : null}
      </section>

      {composition?.incoming.length ? (
        <section className="inside-others is-used-by">
          <div className="inside-stage-head">
            <h3>Other skills use this one</h3>
          </div>
          <p>Changing its name or what it does affects them. Habi won't change them for you.</p>
          <ul className="inside-rows is-plain">
            {composition.incoming.map((r) => (
              <li key={r.skillId}>
                {r.title}
                <em>{r.explicit ? "part of it" : "mentioned"}</em>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="inside-foot">
        <p>Token counts are rough: about four characters each. Agents load things differently.</p>
        <p className="inside-links">
          <button type="button" className="link-btn" onClick={onWhen}>
            Where it applies
          </button>
          <button type="button" className="link-btn" onClick={onReadiness}>
            {ready ? "Ready" : `${problems} to fix`}
          </button>
          <button type="button" className="link-btn" onClick={onSource}>
            What the agent receives
          </button>
        </p>
      </footer>
    </aside>
  );
}
