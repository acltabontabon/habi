/** What can go at the caret, typed for after a slash. Reading the list is how to learn what a page can hold. */
import type { Command } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import {
  type CSSProperties,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  insertRule,
  insertTable,
  setCallout,
  setCodeBlock,
  setHeading,
  setParagraph,
  toggleList,
  toggleQuote,
} from "./commands";
import { schema } from "./markdown/schema";
import { dismissSlash, type SlashState } from "./plugins";

export type SlashItem = {
  id: string;
  group?: string;
  label: string;
  hint?: string;
  run?: Command;
  /** Takes over from the menu with the query so far. */
  act?: (view: EditorView) => void;
  keywords?: string;
};

export type SlashMenuHandle = { key: (event: KeyboardEvent) => boolean };

const { nodes } = schema;

const BUILT_IN: SlashItem[] = [
  { id: "text", label: "Text", hint: "A plain paragraph", run: setParagraph, keywords: "paragraph" },
  { id: "h1", label: "Big heading", run: setHeading(1), keywords: "title h1" },
  { id: "h2", label: "Heading", hint: "Starts a section", run: setHeading(2), keywords: "section h2" },
  { id: "h3", label: "Small heading", run: setHeading(3), keywords: "h3" },
  {
    id: "steps",
    label: "Steps",
    hint: "A numbered procedure",
    run: toggleList(nodes.ordered_list),
    keywords: "ordered numbered list procedure",
  },
  {
    id: "list",
    label: "List",
    hint: "Points in no order",
    run: toggleList(nodes.bullet_list),
    keywords: "bullets unordered",
  },
  {
    id: "code",
    label: "Code",
    hint: "An example the agent can copy",
    run: setCodeBlock,
    keywords: "snippet fence example",
  },
  { id: "note", label: "Note", hint: "Worth knowing", run: setCallout("NOTE"), keywords: "callout tip" },
  {
    id: "warning",
    label: "Warning",
    hint: "Must not be missed",
    run: setCallout("WARNING"),
    keywords: "callout caution danger",
  },
  { id: "quote", label: "Quote", run: toggleQuote, keywords: "blockquote" },
  { id: "table", label: "Table", run: insertTable(), keywords: "grid columns rows" },
  { id: "divider", label: "Divider", run: insertRule, keywords: "rule hr line separator" },
];

function matches(item: SlashItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.keywords ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function SlashMenu({
  ref,
  view,
  slash,
  extras,
}: {
  ref?: Ref<SlashMenuHandle>;
  view: EditorView;
  slash: NonNullable<SlashState>;
  extras?: (query: string) => SlashItem[];
}) {
  const query = slash.query.trim().toLowerCase();
  const items = useMemo(() => {
    const extra = extras?.(query) ?? [];
    const scoped = /^(skill|file)\b/.test(query);
    return scoped ? extra : [...BUILT_IN.filter((i) => matches(i, query)), ...extra];
  }, [query, extras]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  });

  const choose = (item: SlashItem) => {
    // The typed `/words` go first, in the same undo step as what they asked for.
    view.dispatch(view.state.tr.delete(slash.from, slash.to));
    if (item.run) item.run(view.state, view.dispatch, view);
    else item.act?.(view);
    view.focus();
  };

  useImperativeHandle(ref, () => ({
    key: (e) => {
      if (items.length === 0) {
        if (e.key === "Enter" || e.key === "Tab") {
          dismissSlash(view);
          return false;
        }
        return false;
      }
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % items.length);
      else if (e.key === "ArrowUp") setActive((a) => (a - 1 + items.length) % items.length);
      else {
        const item = items[active];
        if (item) choose(item);
      }
      return true;
    },
  }));

  if (view.state.selection instanceof CellSelection) return null;
  const at = view.coordsAtPos(slash.from);
  const below = at.bottom + 320 < window.innerHeight;
  const style: CSSProperties = below
    ? { left: at.left, top: at.bottom + 6 }
    : { left: at.left, bottom: window.innerHeight - at.top + 6 };
  const groups: { name: string | null; items: { item: SlashItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const name = item.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push({ item, index });
    else groups.push({ name, items: [{ item, index }] });
  });

  return (
    <div className="doc-slash" style={style} role="listbox" aria-label="Add to the page">
      {items.length === 0 ? (
        <p className="doc-slash-none">Nothing called that</p>
      ) : (
        <ul ref={list}>
          {groups.map((g) => (
            <li key={g.name ?? "blocks"} role="presentation">
              {g.name ? <div className="doc-slash-group">{g.name}</div> : null}
              <ul role="presentation">
                {g.items.map(({ item, index }) => (
                  <li key={item.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      className={index === active ? "is-active" : undefined}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(item)}
                    >
                      <span className="doc-slash-label">{item.label}</span>
                      {item.hint ? <span className="doc-slash-hint">{item.hint}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
