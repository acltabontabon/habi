/**
 * The handle in the margin beside the block under the pointer. Pick it up to move
 * the block (from a heading, the whole section comes along), or press it for the
 * same things by name. Alt+↑ and Alt+↓ do it from the keyboard. The + beside it
 * starts a new block right there.
 */
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { type RefObject, useEffect, useRef, useState } from "react";
import { moveBlock, setHeading, setParagraph, toggleList } from "./commands";
import { armDrag, ghostOfBlocks } from "./drag";
import { schema } from "./markdown/schema";
import { moveBlocks, moveItem, sectionRange } from "./moves";
import { composedUseIn } from "./uses";

export type BlockMenuTarget = { pos: number; left: number; top: number };

type Spot = {
  pos: number;
  left: number;
  top: number;
  node: PMNode;
  /** The block has its own knot or number, and that is what you pick up. */
  bead: boolean;
};

/** The block at a point: a list item rather than the whole list, otherwise the top-level block. */
function blockAt(view: EditorView, x: number, y: number): { pos: number; node: PMNode } | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  for (let d = $pos.depth; d >= 0; d--) {
    const node = d === 0 ? null : $pos.node(d);
    if (node?.type === schema.nodes.list_item) return { pos: $pos.before(d), node };
    if (d === 1 && node) return { pos: $pos.before(1), node };
  }
  const after = view.state.doc.nodeAt(hit.inside >= 0 ? hit.inside : hit.pos);
  return after?.isBlock ? { pos: hit.inside >= 0 ? hit.inside : hit.pos, node: after } : null;
}

export function BlockHandle({
  view,
  host,
  menu,
  onMenu,
  tick,
  onLiftUse,
}: {
  view: EditorView;
  host: RefObject<HTMLDivElement | null>;
  menu: BlockMenuTarget | null;
  onMenu: (target: BlockMenuTarget | null) => void;
  tick: number;
  onLiftUse?: (pos: number, event: PointerEvent) => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const handle = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick means the page changed under the handle.
  useEffect(() => {
    setSpot(null);
  }, [tick]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wrap = el.parentElement;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (frame) return;
      const { clientX: x, clientY: y } = e;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = view.dom.getBoundingClientRect();
        // Past the numbers that hang in a list's padding: over one, it's that step that's meant.
        const found = blockAt(view, Math.max(x, box.left + 44), y);
        if (!found || found.node.type === schema.nodes.doc) return setSpot(null);
        const dom = view.nodeDOM(found.pos);
        if (!(dom instanceof HTMLElement) || !wrap) return setSpot(null);
        const rect = dom.getBoundingClientRect();
        const origin = wrap.getBoundingClientRect();
        const style = window.getComputedStyle(dom);
        const lineHeight = Number.parseFloat(style.lineHeight) || 24;
        const padding = Number.parseFloat(style.paddingTop) || 0;
        const left = rect.left - origin.left;
        const top = rect.top - origin.top;
        const parent = view.state.doc.resolve(found.pos);
        const step =
          found.node.type === schema.nodes.list_item &&
          parent.depth === 1 &&
          parent.parent.type === schema.nodes.ordered_list;
        // A step's number and a used skill's knot are the things you pick up.
        if (step) setSpot({ pos: found.pos, node: found.node, bead: true, left: left - 36, top: top + 2 });
        else if (dom.classList.contains("doc-use")) {
          setSpot({ pos: found.pos, node: found.node, bead: true, left: left + 8, top: top + 12 });
        } else {
          setSpot({
            pos: found.pos,
            node: found.node,
            bead: false,
            left: left - (found.node.type === schema.nodes.list_item ? 50 : 28),
            top: top + padding + (lineHeight - 22) / 2,
          });
        }
      });
    };
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget instanceof Node && wrap?.contains(e.relatedTarget)) return;
      setSpot(null);
    };
    wrap?.addEventListener("mousemove", onMove);
    wrap?.addEventListener("mouseleave", onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      wrap?.removeEventListener("mousemove", onMove);
      wrap?.removeEventListener("mouseleave", onLeave);
    };
  }, [view, host]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".doc-block-menu")) onMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onMenu(null);
        view.focus();
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [menu, onMenu, view]);

  const select = (pos: number) => {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  };

  const act = (target: BlockMenuTarget, what: string) => {
    onMenu(null);
    select(target.pos);
    const { state, dispatch } = view;
    const node = state.doc.nodeAt(target.pos);
    switch (what) {
      case "up":
        moveBlock(-1)(view.state, dispatch);
        break;
      case "down":
        moveBlock(1)(view.state, dispatch);
        break;
      case "delete":
        if (node) dispatch(view.state.tr.delete(target.pos, target.pos + node.nodeSize));
        break;
      case "duplicate":
        if (node) dispatch(view.state.tr.insert(target.pos + node.nodeSize, node));
        break;
      default:
        break;
    }
    view.focus();
  };

  const turn = (target: BlockMenuTarget, what: "text" | "heading" | "steps") => {
    onMenu(null);
    const node = view.state.doc.nodeAt(target.pos);
    if (!node) return;
    const inside = view.state.doc.resolve(target.pos + 1);
    if (inside.parent.isTextblock || inside.nodeAfter?.isTextblock) {
      view.dispatch(view.state.tr.setSelection(NodeSelection.near(inside)));
    }
    const command =
      what === "heading"
        ? setHeading(2)
        : what === "steps"
          ? toggleList(schema.nodes.ordered_list)
          : setParagraph;
    command(view.state, view.dispatch);
    view.focus();
  };

  return (
    <>
      {spot ? (
        <>
          <button
            type="button"
            className="doc-add"
            style={{ left: spot.left - 22, top: spot.top }}
            aria-label="Add a block below"
            title="Add a block below"
            tabIndex={-1}
            onClick={() => {
              const size = spot.node.nodeSize;
              const at = spot.pos + size;
              const para = schema.nodes.paragraph.create();
              const item = spot.node.type === schema.nodes.list_item;
              const tr = view.state.tr.insert(at, item ? schema.nodes.list_item.create(null, para) : para);
              tr.setSelection(NodeSelection.near(tr.doc.resolve(at + (item ? 2 : 1))));
              if (!item) tr.insertText("/");
              view.dispatch(tr.scrollIntoView());
              view.focus();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            ref={handle}
            type="button"
            className={`doc-handle${spot.bead ? " is-bead" : ""}`}
            style={{ left: spot.left, top: spot.top }}
            aria-label="Move or change this block"
            title={
              spot.node.type === schema.nodes.heading
                ? "Drag to move this whole section. Click for more."
                : "Drag to move. Click for more."
            }
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              const { pos, node } = spot;
              const use = composedUseIn(node);
              if (use && onLiftUse) {
                onLiftUse(pos + 1 + use.offset, e.nativeEvent);
                return;
              }
              armDrag(e.nativeEvent, () => {
                const item = node.type === schema.nodes.list_item;
                const range =
                  node.type === schema.nodes.heading
                    ? (sectionRange(view.state.doc, pos) ?? { from: pos, to: pos + node.nodeSize })
                    : { from: pos, to: pos + node.nodeSize };
                const { ghost, count } = ghostOfBlocks(view, range.from, range.to);
                if (count > 4) ghost.dataset.more = `and ${count - 4} more`;
                return {
                  view,
                  ghost,
                  grip: { x: 18, y: 16 },
                  source: { ...range, list: item },
                  onLand: (landing) => {
                    if (landing.type !== "slot") return;
                    if (item) moveItem(view, range.from, range.to, landing.slot.pos);
                    else moveBlocks(view, range.from, range.to, landing.slot.pos);
                    view.focus();
                  },
                };
              });
            }}
            onClick={() => onMenu({ pos: spot.pos, left: spot.left, top: spot.top + 26 })}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
              <circle cx="2.5" cy="2.5" r="1.2" />
              <circle cx="7.5" cy="2.5" r="1.2" />
              <circle cx="2.5" cy="7" r="1.2" />
              <circle cx="7.5" cy="7" r="1.2" />
              <circle cx="2.5" cy="11.5" r="1.2" />
              <circle cx="7.5" cy="11.5" r="1.2" />
            </svg>
          </button>
        </>
      ) : null}
      {menu ? (
        <div
          className="doc-block-menu"
          style={{ left: menu.left, top: menu.top }}
          role="menu"
          aria-label="This block"
        >
          <button type="button" role="menuitem" onClick={() => act(menu, "up")}>
            Move up <kbd>⌥↑</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => act(menu, "down")}>
            Move down <kbd>⌥↓</kbd>
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => turn(menu, "text")}>
            Turn into text
          </button>
          <button type="button" role="menuitem" onClick={() => turn(menu, "heading")}>
            Turn into heading
          </button>
          <button type="button" role="menuitem" onClick={() => turn(menu, "steps")}>
            Turn into steps
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => act(menu, "duplicate")}>
            Duplicate
          </button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => act(menu, "delete")}>
            Delete
          </button>
        </div>
      ) : null}
    </>
  );
}
