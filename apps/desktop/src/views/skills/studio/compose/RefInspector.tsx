/**
 * One use of a skill, opened where it is. The author can say what it's for, see
 * whether it can be found, and change or remove this one use. Availability says
 * only what Habi checked: an agent that isn't listed is one nobody asked about.
 */
import { useEffect, useRef } from "react";
import type { Dependency } from "../../../../bindings/Dependency";
import type { ShelfSkill } from "../../../../bindings/ShelfSkill";
import { Button } from "../../../../components/ui";
import { clientName } from "./clients";
import { KNOT, titleOfName } from "./knots";
import { ROLES, type RoleId, roleInfo, USED_HERE } from "./roles";

export type InspectorTarget = {
  name: string;
  pos: number;
  rect: { left: number; top: number; bottom: number };
  role: string | null;
  /** The other places this skill is used, for jumping to. */
  otherUses: number[];
  canReword: boolean;
};

function statusLine(
  dep: Dependency | undefined,
  shelf: ShelfSkill[],
): { text: string; tone: "ok" | "unsure" | "missing" } {
  if (!dep) {
    return shelf.length
      ? {
          text: `A skill with this name is in ${shelf.map((s) => s.sourceLabel).join(", ")}.`,
          tone: "unsure",
        }
      : { text: "Habi can't find a skill with this name.", tone: "missing" };
  }
  switch (dep.status) {
    case "exact":
      return dep.changedSinceLinked
        ? { text: "It has changed since it was added here.", tone: "unsure" }
        : { text: "The same skill that was added here.", tone: "ok" };
    case "named":
      // Only a recorded source can differ from what's found: otherwise the name is all there is to go on.
      if (dep.from?.library) {
        return {
          text: "A skill with this name is here, but not from where it was added. It may not be the same one.",
          tone: "unsure",
        };
      }
      return {
        text: shelf[0] ? `Found by name, in ${shelf[0].sourceLabel.toLowerCase()}.` : "Found by name.",
        tone: "ok",
      };
    case "ambiguous":
      return { text: "Different skills have this name. An agent could find any of them.", tone: "unsure" };
    case "selfReference":
      return { text: "This is the skill you're editing.", tone: "unsure" };
    default:
      return { text: "Not found on this machine or in your libraries.", tone: "missing" };
  }
}

export function RefInspector({
  target,
  dependency,
  shelf,
  onRole,
  onMakePart,
  onRemove,
  onReplace,
  onJump,
  onOpenSkill,
  onConnect,
  onFind,
  onClose,
}: {
  target: InspectorTarget;
  dependency: Dependency | undefined;
  /** Copies of it on the shelf. */
  shelf: ShelfSkill[];
  onRole: (role: RoleId) => void;
  onMakePart: () => void;
  onRemove: () => void;
  onReplace: (all: boolean) => void;
  onJump: (pos: number) => void;
  onOpenSkill: (skill: ShelfSkill) => void;
  onConnect: (url: string) => void;
  onFind: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button, [href], input")?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);

  const explicit = target.role !== null;
  const best = shelf[0];
  const title = best?.title ?? titleOfName(target.name);
  const status = statusLine(dependency, shelf);
  const availability = dependency?.availability ?? [];
  const library = dependency?.from?.library ?? null;
  const missing = status.tone === "missing";

  const below = target.rect.bottom + 380 < window.innerHeight;
  const left = Math.min(Math.max(16, target.rect.left - 12), window.innerWidth - 376);
  const style = below
    ? { left, top: target.rect.bottom + 8 }
    : { left, bottom: window.innerHeight - target.rect.top + 8 };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in it closes it.
    <div
      ref={root}
      className="ref-pop"
      style={style}
      role="dialog"
      aria-label={`${title} skill`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="ref-head">
        <span
          className={`ref-knot${missing ? " is-ghost" : ""}`}
          style={{ background: missing ? undefined : KNOT }}
          aria-hidden="true"
        />
        <div className="ref-title">
          <h3>{title}</h3>
          {best?.description ? <p>{best.description}</p> : null}
        </div>
      </header>

      {explicit ? (
        <fieldset className="ref-roles">
          <legend>How it's used here</legend>
          <div className="ref-role-list">
            {ROLES.map((r) => (
              <label key={r.id} className={target.role === r.id ? "is-on" : undefined}>
                <input
                  type="radio"
                  name="ref-role"
                  checked={target.role === r.id}
                  onChange={() => onRole(r.id)}
                />
                {r.label}
              </label>
            ))}
          </div>
          {target.role === USED_HERE ? (
            <p className="ref-hint">Choose one to say what it's for. Habi hasn't assumed.</p>
          ) : !target.canReword && roleInfo(target.role) ? (
            <p className="ref-hint">Your sentence stays as you wrote it.</p>
          ) : null}
        </fieldset>
      ) : (
        <div className="ref-mentioned">
          <p>Only named in the words, so Habi doesn't check it.</p>
          <Button onClick={onMakePart}>Link this skill</Button>
        </div>
      )}

      <section className={`ref-where is-${status.tone}`}>
        <p className="ref-status">{status.text}</p>
        {availability.length ? (
          <ul className="ref-agents" aria-label="Which agents would find it">
            {availability.map((a) => (
              <li key={a.client} className={`is-${a.state}`}>
                <span className="ref-agent">{clientName(a.client)}</span>
                <span className="ref-state">
                  {a.state === "found"
                    ? `found${a.place ? `, ${a.place}` : ""}`
                    : a.state === "notFound"
                      ? "not found"
                      : "couldn't check"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="ref-truth">
          A link is a pointer, not a requirement. Agents decide for themselves whether to use it, and linking
          installs nothing.
        </p>
      </section>

      {missing ? (
        <div className="ref-ghost-actions">
          {library ? (
            <Button onClick={() => onConnect(library)} title={library}>
              Connect the library it came from
            </Button>
          ) : null}
          <Button onClick={onFind}>Find a match</Button>
        </div>
      ) : null}

      {target.otherUses.length ? (
        <p className="ref-others">
          Also used{" "}
          {target.otherUses.map((pos, i) => (
            <span key={pos}>
              {i > 0 ? ", " : ""}
              <button type="button" className="link-btn" onClick={() => onJump(pos)}>
                {i === 0 ? "here" : `here (${i + 1})`}
              </button>
            </span>
          ))}
          . Changes apply only to this one.
        </p>
      ) : null}

      <footer className="ref-actions">
        <button type="button" className="link-btn" onClick={() => onReplace(false)}>
          Link another skill
        </button>
        {target.otherUses.length ? (
          <button type="button" className="link-btn" onClick={() => onReplace(true)}>
            Replace all {target.otherUses.length + 1}
          </button>
        ) : null}
        {best ? (
          <button type="button" className="link-btn" onClick={() => onOpenSkill(best)}>
            {best.origin === "mine" ? "Open it" : "Look at it"}
          </button>
        ) : null}
        <button type="button" className="link-btn is-danger" onClick={onRemove}>
          Remove from here
        </button>
      </footer>
    </div>
  );
}
