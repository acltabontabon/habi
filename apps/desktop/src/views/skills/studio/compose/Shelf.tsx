/**
 * The skills within reach: what you've made, what's on this machine, what's in
 * your projects and libraries. Choosing one only ever writes a sentence into this
 * draft. Nothing is installed, copied or run by being here, or by being dragged.
 */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ShelfSkill } from "../../../../bindings/ShelfSkill";
import { Icon } from "../../../../components/Icon";
import { knotColor } from "./knots";

const ORDER: Record<string, number> = { mine: 0, machine: 1, project: 2, library: 3, community: 4 };

export function matchesQuery(skill: ShelfSkill, query: string): boolean {
  if (!query) return true;
  const hay = `${skill.title} ${skill.name} ${skill.description}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function group(skills: ShelfSkill[]): { label: string; items: ShelfSkill[] }[] {
  const groups = new Map<string, { label: string; rank: number; items: ShelfSkill[] }>();
  for (const s of skills) {
    const key = `${s.origin}:${s.sourceLabel}`;
    const g = groups.get(key) ?? { label: s.sourceLabel, rank: ORDER[s.origin] ?? 9, items: [] };
    g.items.push(s);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function otherCopies(s: ShelfSkill): string | null {
  if (s.duplicates === 0) return null;
  const others = s.duplicates === 1 ? "another copy" : `${s.duplicates} other copies`;
  if (s.sameContent === s.duplicates) return `Same as ${others}`;
  if (s.sameContent === 0) return `Differs from ${others}`;
  return `Same as ${s.sameContent} of ${s.duplicates} other copies`;
}

export function Shelf({
  skills,
  loading,
  initialQuery = "",
  title = "Use a skill",
  note,
  currentName,
  onPick,
  onClose,
  onLift,
}: {
  skills: ShelfSkill[] | undefined;
  loading: boolean;
  initialQuery?: string;
  title?: string;
  /** What choosing will do, when it isn't the usual. */
  note?: string;
  /** This skill itself: it can't be part of itself. */
  currentName: string;
  onPick: (skill: ShelfSkill) => void;
  onClose: () => void;
  /** It was picked up, to carry to the page. */
  onLift?: (skill: ShelfSkill, event: PointerEvent) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const found = useMemo(
    // Something with no name yet can't be named by another skill.
    () => (skills ?? []).filter((s) => s.name && s.name !== currentName && matchesQuery(s, query.trim())),
    [skills, query, currentName],
  );
  const groups = useMemo(() => group(found), [found]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search starts at its first result.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = flat[active];
      if (s) onPick(s);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowRight" && input.current?.selectionStart === query.length) {
      const s = flat[active];
      if (s) setOpen(s.key);
    } else if (e.key === "ArrowLeft" && open) {
      setOpen(null);
    }
  };

  let index = -1;
  return (
    <aside className="shelf" aria-label={title}>
      <header className="shelf-head">
        <h2>{title}</h2>
        <button type="button" className="shelf-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      {note ? <p className="shelf-note">{note}</p> : null}
      <label className="shelf-search">
        <span className="visually-hidden">Find a skill</span>
        <input
          ref={input}
          value={query}
          placeholder="What should it know how to do?"
          role="combobox"
          aria-expanded="true"
          aria-controls="shelf-results"
          aria-activedescendant={flat[active] ? `shelf-${flat[active].key}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
      </label>
      <div className="shelf-list" id="shelf-results" role="listbox" aria-label="Skills" ref={list}>
        {loading && !skills ? <p className="shelf-empty">Looking through your skills…</p> : null}
        {skills && flat.length === 0 ? (
          <p className="shelf-empty">
            {query
              ? `Nothing here does “${query}”.`
              : "No other skills yet. Skills you make, and any on this machine or in your libraries, show up here."}
          </p>
        ) : null}
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: inside a listbox, options are grouped by this role; a fieldset isn't allowed there.
          <section key={g.label} className="shelf-group" role="group" aria-label={g.label}>
            <h3 role="presentation">{g.label}</h3>
            {g.items.map((s) => {
              index += 1;
              const here = index;
              const expanded = open === s.key;
              const copies = otherCopies(s);
              return (
                <div
                  key={s.key}
                  id={`shelf-${s.key}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={here === active}
                  className={`shelf-row${here === active ? " is-active" : ""}${expanded ? " is-open" : ""}`}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest(".shelf-info")) return;
                    onLift?.(s, e.nativeEvent);
                  }}
                  onMouseEnter={() => setActive(here)}
                  onClick={() => onPick(s)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onPick(s);
                  }}
                >
                  <span className="shelf-knot" style={{ background: knotColor(s.name) }} aria-hidden="true" />
                  <span className="shelf-words">
                    <span className="shelf-name">{s.title || s.name || "Untitled skill"}</span>
                    <span className={`shelf-what${expanded ? " is-open" : ""}`}>
                      {s.description || "No description."}
                    </span>
                    {expanded ? (
                      <span className="shelf-more">
                        <span>From {s.sourceLabel}</span>
                        {copies ? <span>{copies}</span> : null}
                        {s.readers.length ? <span>Read by {s.readers.join(", ")}</span> : null}
                        {s.cautions.map((c) => (
                          <span key={c} className="is-caution">
                            {c}
                          </span>
                        ))}
                      </span>
                    ) : s.cautions.length ? (
                      <span className="shelf-flag">
                        {s.cautions.length === 1 ? s.cautions[0] : `${s.cautions.length} things to check`}
                      </span>
                    ) : copies && copies.startsWith("Differs") ? (
                      <span className="shelf-flag">{copies}</span>
                    ) : null}
                  </span>
                  {/* The keyboard's way is the right arrow, from the search box. */}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for what ArrowRight does. */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
                  <span
                    className="shelf-info"
                    aria-hidden="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(expanded ? null : s.key);
                    }}
                  >
                    {expanded ? "Less" : "More"}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <footer className="shelf-foot">
        Choosing adds it to these instructions. It doesn't install or run anything.
      </footer>
    </aside>
  );
}
