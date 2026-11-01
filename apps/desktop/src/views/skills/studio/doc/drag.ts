/**
 * Picking things up. Anything on the page, or brought to it, lifts under the
 * pointer while the page closes the hole it left and opens where it would land.
 * It's a single undoable edit when it lands, and Escape puts it all back. Every
 * drag here has a keyboard way to do the same thing: Alt+arrows, the tray's
 * buttons, the shelf's Enter.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/** A place something can land, between two blocks or two list items. */
export type Slot = { pos: number; y: number; left: number; width: number; index: number; list: boolean };

export type Landing =
  /** Between blocks. */
  | { type: "slot"; slot: Slot }
  /** Inside a sentence. */
  | { type: "text"; pos: number }
  | { type: "instruction"; pos: number; rect: DOMRect }
  /** Pulled away from everything, for what can be pulled off. */
  | { type: "pull" };

export type DragSpec = {
  view: EditorView;
  /** What rides under the pointer. Handed over to the drag, which removes it. */
  ghost: HTMLElement;
  /** Where the pointer holds it, from its top left. */
  grip?: { x: number; y: number };
  /** The stretch of the document being moved, if it's already on the page. */
  source?: { from: number; to: number; list?: boolean };
  /** Whether it can land inside a sentence, as a word. */
  inline?: boolean;
  /** Land on a complete instruction, including an individual list step. */
  instructions?: boolean;
  instructionsOnly?: boolean;
  listInsert?: boolean;
  stationary?: boolean;
  canvasOnly?: boolean;
  /** Whether letting go here would take it off the page. */
  pulls?: (x: number, y: number) => boolean;
  /** A line from something to the pointer, redrawn as it moves. */
  tether?: () => { x: number; color: string } | null;
  onLand: (landing: Landing) => void;
};

const THRESHOLD = 4;

function reduced(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Top-level blocks and their DOM, in order. */
function topBlocks(view: EditorView): { pos: number; node: PMNode; el: HTMLElement }[] {
  const out: { pos: number; node: PMNode; el: HTMLElement }[] = [];
  view.state.doc.forEach((node, pos) => {
    const el = view.nodeDOM(pos);
    if (el instanceof HTMLElement) out.push({ pos, node, el });
  });
  return out;
}

function topSlots(view: EditorView): Slot[] {
  const blocks = topBlocks(view);
  const box = view.dom.getBoundingClientRect();
  const slots: Slot[] = [];
  blocks.forEach((b, i) => {
    const rect = b.el.getBoundingClientRect();
    const prev = blocks[i - 1]?.el.getBoundingClientRect();
    const y = prev ? (prev.bottom + rect.top) / 2 : rect.top - 4;
    slots.push({ pos: b.pos, y, left: box.left, width: box.width, index: i, list: false });
  });
  const last = blocks[blocks.length - 1];
  if (last) {
    const rect = last.el.getBoundingClientRect();
    slots.push({
      pos: last.pos + last.node.nodeSize,
      y: rect.bottom + 8,
      left: box.left,
      width: box.width,
      index: blocks.length,
      list: false,
    });
  }
  return slots;
}

/** Between list items, for an item being moved: any list will do. */
function itemSlots(view: EditorView): Slot[] {
  const slots: Slot[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "bullet_list" && node.type.name !== "ordered_list") return true;
    let at = pos + 1;
    node.forEach((item, _o, i) => {
      const el = view.nodeDOM(at);
      if (el instanceof HTMLElement) {
        const r = el.getBoundingClientRect();
        slots.push({ pos: at, y: r.top - 1, left: r.left, width: r.width, index: i, list: true });
        if (i === node.childCount - 1) {
          slots.push({
            pos: at + item.nodeSize,
            y: r.bottom + 1,
            left: r.left,
            width: r.width,
            index: i + 1,
            list: true,
          });
        }
      }
      at += item.nodeSize;
    });
    return true;
  });
  return slots;
}

function nearest(slots: Slot[], y: number): Slot | null {
  let best: Slot | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    const d = Math.abs(s.y - y);
    if (d < distance) {
      best = s;
      distance = d;
    }
  }
  return best;
}

/** A path from the page to an element, for styling it without touching it. */
function selectorFor(root: HTMLElement, el: Element): string {
  const parts: string[] = [];
  for (let at: Element | null = el; at && at !== root; at = at.parentElement) {
    const parent: Element | null = at.parentElement;
    if (!parent) break;
    parts.unshift(`> :nth-child(${[...parent.children].indexOf(at) + 1})`);
  }
  return `.doc-page.is-parting ${parts.join(" ")}`;
}

function run(spec: DragSpec, start: PointerEvent): void {
  const { view, ghost, source } = spec;
  const doc = view.dom as HTMLElement;
  const stage = doc.closest<HTMLElement>(".sk-stage");
  const itemMove = source?.list === true;
  const blocks = topBlocks(view);

  const grip = spec.grip ?? { x: 16, y: 16 };
  ghost.classList.add("doc-ghost");
  ghost.setAttribute("aria-hidden", "true");
  document.body.append(ghost);
  document.body.classList.add("is-lifting");

  // The hole it leaves closes up, and the page below moves with it.
  const inSource = (pos: number) =>
    source !== undefined && !itemMove && pos >= source.from && pos < source.to;
  const lifted = blocks.filter((b) => inSource(b.pos));
  const firstAfter = blocks.findIndex((b) => source !== undefined && b.pos >= source.to);
  // Exactly the room it took, margins included, so the page below closes up cleanly.
  const liftedHeight = lifted.length
    ? (blocks[firstAfter]?.el.getBoundingClientRect().top ??
        (lifted[lifted.length - 1]?.el.getBoundingClientRect().bottom ?? 0) + 18) -
      (lifted[0]?.el.getBoundingClientRect().top ?? 0)
    : 0;

  // ProseMirror redraws a node whose attributes change under it, so nothing on the page
  // is touched: the whole parting is one stylesheet, rewritten as the pointer moves.
  const sheet = document.createElement("style");
  document.head.append(sheet);
  const stillRules: string[] = [];
  for (const b of lifted) {
    stillRules.push(`.doc-page.is-parting > :nth-child(${blocks.indexOf(b) + 1}) { visibility: hidden; }`);
  }
  if (itemMove && source) {
    const el = view.nodeDOM(source.from);
    if (el instanceof Element) stillRules.push(`${selectorFor(doc, el)} { opacity: 0.25; }`);
  }

  const gapMark = document.createElement("div");
  gapMark.className = "doc-gap";
  gapMark.setAttribute("aria-hidden", "true");
  document.body.append(gapMark);
  const stepTarget = document.createElement("div");
  stepTarget.className = "doc-step-target";
  stepTarget.setAttribute("aria-hidden", "true");
  stepTarget.textContent = "Connect to this step";
  document.body.append(stepTarget);
  const caret = document.createElement("div");
  caret.className = "doc-word-gap";
  caret.setAttribute("aria-hidden", "true");
  document.body.append(caret);

  const tether = spec.tether ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
  const tetherPath = tether ? document.createElementNS("http://www.w3.org/2000/svg", "path") : null;
  if (tether && tetherPath) {
    tether.setAttribute("class", "doc-tether");
    tether.setAttribute("aria-hidden", "true");
    tether.append(tetherPath);
    document.body.append(tether);
  }

  const gapSize = Math.max(ghost.offsetHeight + 14, 34);
  let x = start.clientX;
  let y = start.clientY;
  let landing: Landing | null = null;
  let frame = 0;
  let scrollFrame = 0;
  let ended = false;

  // Measured once, with nothing moved: the page shifts under the pointer, the targets don't.
  const slots = spec.listInsert
    ? [...itemSlots(view), ...topSlots(view)]
    : itemMove
      ? itemSlots(view)
      : topSlots(view);
  const scrollAtMeasure = stage?.scrollTop ?? 0;
  doc.classList.add("is-parting");
  const firstLifted = lifted.length ? blocks.indexOf(lifted[0] as (typeof blocks)[number]) : -1;

  const paint = () => {
    frame = 0;
    if (ended) return;
    const scrolled = (stage?.scrollTop ?? 0) - scrollAtMeasure;
    // Always all on screen, however near the edge it's carried.
    const room = window.innerWidth - ghost.offsetWidth - 8;
    ghost.style.transform = `translate(${Math.max(8, Math.min(x - grip.x, Math.max(room, 8)))}px, ${y - grip.y}px)`;
    const pull = spec.pulls?.(x, y) ?? false;
    ghost.classList.toggle("is-pulled", pull);
    let next: Landing | null = pull ? { type: "pull" } : null;

    const stageBox = stage?.getBoundingClientRect();
    const insideStage = !stageBox || (y >= stageBox.top && y <= stageBox.bottom);
    if (!pull && spec.instructions && insideStage) {
      const hits: { landing: Extract<Landing, { type: "instruction" }>; distance: number }[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name !== "paragraph") return true;
        const el = view.nodeDOM(pos);
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const step = el.closest("li");
        const box = step?.getBoundingClientRect() ?? rect;
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
          hits.push({
            landing: { type: "instruction", pos, rect },
            distance: Math.max(rect.top - y, y - rect.bottom, 0),
          });
        return false;
      });
      next = hits.sort((a, b) => a.distance - b.distance)[0]?.landing ?? next;
    }
    if (!pull && !next && !spec.instructionsOnly && spec.inline) {
      // Over the words of a sentence, it becomes a word.
      const hit = view.posAtCoords({ left: x, top: y });
      if (hit) {
        const $pos = view.state.doc.resolve(hit.pos);
        if ($pos.parent.isTextblock && !$pos.parent.type.spec.code && $pos.parent.content.size > 0) {
          const coords = view.coordsAtPos(hit.pos);
          if (y >= coords.top - 3 && y <= coords.bottom + 3) next = { type: "text", pos: hit.pos };
        }
      }
    }
    const pageBox = doc.getBoundingClientRect();
    if (
      !pull &&
      !next &&
      !spec.instructionsOnly &&
      (!spec.canvasOnly || insideStage) &&
      x >= pageBox.left &&
      x <= pageBox.right
    ) {
      // The closest place, reckoned as if the hole had already closed.
      const adjusted = slots.map((s) => {
        const shift = firstLifted >= 0 && s.index > firstLifted ? liftedHeight : 0;
        return { ...s, y: s.y - scrolled - shift };
      });
      const slot = nearest(adjusted, y);
      if (slot) next = { type: "slot", slot };
    }
    landing = next;

    stepTarget.classList.toggle("is-on", landing?.type === "instruction");
    if (landing?.type === "instruction") {
      const r = landing.rect;
      stepTarget.style.left = `${r.left - 5}px`;
      stepTarget.style.top = `${r.top - 5}px`;
      stepTarget.style.width = `${r.width + 10}px`;
      stepTarget.style.height = `${r.height + 10}px`;
    }
    // Everything takes its place.
    // Keep instruction targets stationary as a contribution crosses the gaps.
    const open =
      landing?.type === "slot" && !itemMove && !spec.instructions && !spec.stationary
        ? landing.slot.index
        : -1;
    const rules = [...stillRules];
    blocks.forEach((b, i) => {
      if (inSource(b.pos)) return;
      let shift = 0;
      if (firstAfter >= 0 && i >= firstAfter && liftedHeight) shift -= liftedHeight;
      if (open >= 0 && i >= open) shift += gapSize;
      if (shift)
        rules.push(`.doc-page.is-parting > :nth-child(${i + 1}) { transform: translateY(${shift}px); }`);
    });
    sheet.textContent = rules.join("\n");

    gapMark.classList.toggle("is-on", landing?.type === "slot");
    if (landing?.type === "slot") {
      const s = landing.slot;
      const top = s.y - scrolled - (firstLifted >= 0 && s.index > firstLifted ? liftedHeight : 0);
      gapMark.style.transform = `translate(${s.left}px, ${open >= 0 ? top + gapSize / 2 - 7 : top}px)`;
      gapMark.style.width = `${s.width}px`;
    }
    caret.classList.toggle("is-on", landing?.type === "text");
    if (landing?.type === "text") {
      const c = view.coordsAtPos(landing.pos);
      caret.style.transform = `translate(${c.left - 1}px, ${c.top}px)`;
      caret.style.height = `${c.bottom - c.top}px`;
    }

    if (tether && tetherPath) {
      const from = spec.tether?.();
      if (from && !pull) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        tether.setAttribute("viewBox", `0 0 ${w} ${h}`);
        const mx = (from.x + x) / 2;
        tetherPath.setAttribute(
          "d",
          `M ${from.x} ${y + 40} C ${from.x} ${y + 8}, ${mx} ${y + 24}, ${x} ${y}`,
        );
        tetherPath.setAttribute("stroke", from.color);
        tether.style.display = "";
      } else tether.style.display = "none";
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  // Near the edge of the page, it scrolls.
  const edgeScroll = () => {
    scrollFrame = requestAnimationFrame(edgeScroll);
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
    const zone = 56;
    const speed =
      y < box.top + zone
        ? -((box.top + zone - y) / 4)
        : y > box.bottom - zone
          ? (y - box.bottom + zone) / 4
          : 0;
    if (speed) {
      stage.scrollTop += speed;
      schedule();
    }
  };
  scrollFrame = requestAnimationFrame(edgeScroll);

  const cleanup = () => {
    ended = true;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(scrollFrame);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("is-lifting");
    doc.classList.remove("is-parting");
    sheet.remove();
    gapMark.remove();
    caret.remove();
    stepTarget.remove();
    tether?.remove();
  };

  function onMove(e: PointerEvent) {
    e.preventDefault();
    x = e.clientX;
    y = e.clientY;
    schedule();
  }
  function settleGhost(to: DOMRect | null) {
    if (reduced() || !to) {
      ghost.remove();
      return;
    }
    ghost.classList.add("is-landing");
    ghost.style.transform = `translate(${to.left}px, ${to.top}px)`;
    window.setTimeout(() => ghost.remove(), 170);
  }
  function onUp(e: PointerEvent) {
    e.preventDefault();
    x = e.clientX;
    y = e.clientY;
    paint();
    const chosen = landing;
    const stageTop = chosen?.type === "slot" ? gapMark.getBoundingClientRect() : null;
    cleanup();
    // The click that ends a drag isn't a click on whatever's underneath.
    const swallow = (c: MouseEvent) => c.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    settleGhost(stageTop);
    if (chosen) spec.onLand(chosen);
  }
  function onCancel() {
    cleanup();
    ghost.remove();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  }
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);

  schedule();
}

/**
 * Starts listening for a drag from a press. A press that doesn't move stays a
 * click, so the same control can be picked up or simply pressed.
 */
export function armDrag(start: PointerEvent, build: () => DragSpec | null): void {
  if (start.button !== 0) return;
  const onMove = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < THRESHOLD) return;
    stop();
    const spec = build();
    if (spec) run(spec, e);
  };
  const stop = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
}

/** A copy of part of the page to carry around, looking as it does on the page. */
export function ghostOfBlocks(
  view: EditorView,
  from: number,
  to: number,
): { ghost: HTMLElement; count: number } {
  const ghost = document.createElement("div");
  ghost.className = "doc-page doc-ghost-page";
  const box = view.dom.getBoundingClientRect();
  ghost.style.width = `${box.width}px`;
  let count = 0;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from) return true;
    if (!node.isBlock) return false;
    const el = view.nodeDOM(pos);
    count++;
    if (count <= 4 && el instanceof HTMLElement) ghost.append(el.cloneNode(true));
    return false;
  });
  // Marks and selection belong to the page, not the copy.
  for (const el of ghost.querySelectorAll(".is-flash, .ProseMirror-selectednode")) {
    el.classList.remove("is-flash", "ProseMirror-selectednode");
  }
  return { ghost, count };
}

/** A small label to carry, for what isn't on the page yet. */
export function ghostLabel(text: string, dye?: string): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "doc-ghost-chip";
  if (dye) {
    const knot = document.createElement("span");
    knot.className = "doc-ghost-knot";
    knot.style.background = dye;
    ghost.append(knot);
  }
  ghost.append(document.createTextNode(text));
  return ghost;
}
