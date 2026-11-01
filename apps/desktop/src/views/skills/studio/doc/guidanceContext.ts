/** Selection and temporary authoring destinations. All behavior still lives in the Markdown. */
import { closeHistory } from "prosemirror-history";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { materialKind } from "../../../../lib/materials";
import type { Pick } from "../compose/edit";
import { guidanceKind } from "./anatomy";
import { moveBlock } from "./commands";
import { schema } from "./markdown/schema";
import { packageUri } from "./materialUses";

export const GUIDANCE_CHANGED = "habi-guidance-context-changed";
export type GuidanceSelection = { from: number; to: number; label: string; location: string };
type Anchor = { from: number; to: number };
type ContextState = { anchors: Map<number, Anchor> };
type ContextAction = { capture: number; anchor: Anchor } | { release: number };
const key = new PluginKey<ContextState>("guidance-context");
let nextTarget = 0;

function words(node: PMNode): string {
  return node
    .textBetween(0, node.content.size, " ", (child) =>
      child.type.name === "skill_ref"
        ? `${String(child.attrs.name)} skill`
        : child.type.name === "image"
          ? String(child.attrs.alt || child.attrs.src)
          : child.type.name === "inline_raw"
            ? String(child.attrs.display ?? child.attrs.raw)
            : child.textContent,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function describe(doc: PMNode, from: number): GuidanceSelection | null {
  if (from < 0 || from >= doc.content.size) return null;
  const node = doc.nodeAt(from);
  if (node?.type.name !== "paragraph") return null;
  const $inside = doc.resolve(from + 1);
  let location = guidanceKind(node) ?? "Instruction";
  for (let depth = $inside.depth; depth > 0; depth--) {
    if (
      $inside.node(depth).type.name === "list_item" &&
      $inside.node(depth - 1).type.name === "ordered_list"
    ) {
      location = `Procedure · step ${Number($inside.node(depth - 1).attrs.start) + $inside.index(depth - 1)}`;
      break;
    }
  }
  return { from, to: from + node.nodeSize, label: words(node) || "New instruction", location };
}

export function selectedGuidance(state: EditorState): GuidanceSelection | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "paragraph") return describe(state.doc, $from.before(depth));
  }
  return describe(state.doc, state.selection.from);
}

export function guidanceContextPlugin(showTools = true): Plugin<ContextState> {
  return new Plugin<ContextState>({
    key,
    state: {
      init: () => ({ anchors: new Map() }),
      apply(tr, previous) {
        const anchors = new Map<number, Anchor>();
        for (const [id, anchor] of previous.anchors) {
          const from = tr.mapping.mapResult(anchor.from, 1);
          const to = tr.mapping.mapResult(anchor.to, -1);
          // Deleting/replacing an instruction invalidates its pending destination.
          // We never redirect a completed material to whichever paragraph follows it.
          if (from.deleted && to.deleted) continue;
          const live = describe(tr.doc, from.pos);
          if (live && live.to === to.pos) anchors.set(id, { from: from.pos, to: to.pos });
        }
        const action = tr.getMeta(key) as ContextAction | undefined;
        if (action && "capture" in action) anchors.set(action.capture, action.anchor);
        if (action && "release" in action) anchors.delete(action.release);
        return { anchors };
      },
    },
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        const selected = selectedGuidance(state);
        const pinned = new Set(
          [...(key.getState(state)?.anchors.values() ?? [])].map((anchor) => anchor.from),
        );
        if (selected)
          decorations.push(
            Decoration.node(selected.from, selected.to, {
              class: `guidance-is-current${pinned.has(selected.from) ? " guidance-is-target" : ""}`,
              "data-current-guidance": "true",
            }),
          );
        if (showTools && selected && selected.label !== "New instruction")
          decorations.push(
            Decoration.widget(
              selected.from,
              (view) => {
                const root = document.createElement("div");
                if (!view.editable) return root;
                root.className = "guidance-unit-tools";
                root.contentEditable = "false";
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "guidance-tools-toggle";
                toggle.textContent = "⋯";
                toggle.title = `${selected.location} options`;
                toggle.setAttribute("aria-label", `${selected.location} options`);
                toggle.setAttribute("aria-expanded", "false");
                const menu = document.createElement("div");
                menu.className = "guidance-tools-menu";
                menu.setAttribute("role", "group");
                menu.setAttribute("aria-label", `${selected.location} actions`);
                menu.hidden = true;
                toggle.addEventListener("mousedown", (event) => event.preventDefault());
                toggle.addEventListener("click", () => {
                  menu.hidden = !menu.hidden;
                  toggle.setAttribute("aria-expanded", String(!menu.hidden));
                  if (!menu.hidden) {
                    menu.style.position = "fixed";
                    menu.style.right = "auto";
                    const rect = toggle.getBoundingClientRect();
                    const bottom =
                      view.dom.closest(".sk-stage")?.getBoundingClientRect().bottom ?? window.innerHeight;
                    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
                    menu.style.top = `${rect.bottom + menu.offsetHeight + 8 > bottom ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
                  }
                });
                root.addEventListener("keydown", (event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    menu.hidden = true;
                    toggle.setAttribute("aria-expanded", "false");
                    toggle.focus();
                  }
                });
                root.append(toggle, menu);
                for (const [action, text] of [
                  ["edit", "Edit"],
                  ["support", "Add support"],
                  ["up", "Move up"],
                  ["down", "Move down"],
                  ["add", selected.location.startsWith("Procedure") ? "Add after procedure" : "Add below"],
                ]) {
                  const button = document.createElement("button");
                  button.type = "button";
                  button.textContent = text ?? "";
                  button.setAttribute("aria-label", text ?? "");
                  button.title = text ?? "";
                  if (action === "up" || action === "down")
                    button.disabled = !moveBlock(action === "up" ? -1 : 1)(view.state);
                  button.addEventListener("mousedown", (event) => event.preventDefault());
                  button.addEventListener("click", (event) => {
                    event.preventDefault();
                    menu.hidden = true;
                    toggle.setAttribute("aria-expanded", "false");
                    view.dom.dispatchEvent(new CustomEvent("habi-guidance-action", { detail: action }));
                  });
                  menu.append(button);
                }
                const slot = document.createElement("div");
                slot.className = "guidance-editor-slot";
                root.append(slot);
                return root;
              },
              {
                key: `guidance-tools-${selected.from}-${state.doc.content.size}`,
                side: -1,
                stopEvent: () => true,
              },
            ),
          );
        for (const anchor of key.getState(state)?.anchors.values() ?? []) {
          if (anchor.from !== selected?.from)
            decorations.push(Decoration.node(anchor.from, anchor.to, { class: "guidance-is-target" }));
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
    view: (view) => {
      const close = (event: PointerEvent) => {
        for (const root of view.dom.querySelectorAll(".guidance-unit-tools")) {
          if (root.contains(event.target as Node)) continue;
          root.querySelector<HTMLElement>(".guidance-tools-menu")?.setAttribute("hidden", "");
          root.querySelector("button")?.setAttribute("aria-expanded", "false");
        }
      };
      document.addEventListener("pointerdown", close);
      return {
        update: () => view.dom.dispatchEvent(new Event(GUIDANCE_CHANGED)),
        destroy: () => document.removeEventListener("pointerdown", close),
      };
    },
  });
}

/** A temporary destination mapped through edits while a picker or material editor is open. */
export type GuidanceTarget = {
  label: string;
  location: string;
  resolve: (view: EditorView) => GuidanceSelection | null;
  release: (view: EditorView) => void;
};

export function captureGuidanceTarget(view: EditorView): GuidanceTarget | null {
  const current = selectedGuidance(view.state);
  // An editor can outlive a hot-reloaded module. Capture against its installed
  // plugin, rather than a newly-created module key that it does not know about.
  const installed = view.state.plugins.find((plugin) => plugin.getState(view.state)?.anchors instanceof Map);
  const activeKey = installed?.spec.key as PluginKey<ContextState> | undefined;
  if (!current || !view.editable || !activeKey) return null;
  while (activeKey.getState(view.state)?.anchors.has(++nextTarget)) {
    /* reserve a live id */
  }
  const id = nextTarget;
  view.dispatch(
    view.state.tr
      .setMeta(activeKey, { capture: id, anchor: { from: current.from, to: current.to } })
      .setMeta("addToHistory", false),
  );
  return {
    label: current.label,
    location: current.location,
    resolve(currentView) {
      const anchor = activeKey.getState(currentView.state)?.anchors.get(id);
      return anchor ? describe(currentView.state.doc, anchor.from) : null;
    },
    release(currentView) {
      currentView.dispatch(
        currentView.state.tr.setMeta(activeKey, { release: id }).setMeta("addToHistory", false),
      );
    },
  };
}

export function subscribeGuidance(view: EditorView, update: () => void): () => void {
  view.dom.addEventListener(GUIDANCE_CHANGED, update);
  return () => view.dom.removeEventListener(GUIDANCE_CHANGED, update);
}

function appendToTarget(
  view: EditorView,
  target: GuidanceTarget,
  content: PMNode[],
  promptOffset: number | null,
): boolean {
  if (!view.editable) return false;
  const destination = target.resolve(view);
  if (!destination) return false;
  const paragraph = view.state.doc.nodeAt(destination.from);
  if (!paragraph) return false;
  const existing = words(paragraph);
  const separator = existing ? (/[.!?:;]$/.test(existing) ? " " : ". ") : "";
  const nodes = separator ? [view.state.schema.text(separator), ...content] : content;
  const at = destination.to - 1;
  const tr = closeHistory(view.state.tr).insert(at, Fragment.fromArray(nodes));
  if (promptOffset !== null) {
    const prompt = at + separator.length + promptOffset;
    tr.setSelection(TextSelection.create(tr.doc, prompt, prompt + 1));
  } else tr.setSelection(TextSelection.near(tr.doc.resolve(at + Fragment.fromArray(nodes).size)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

const intent = (purpose?: string) => purpose?.replace(/\s+/g, " ").trim() || "…";
const end = (purpose: string) => (/[.!?]$/.test(purpose) ? "" : ".");

export function attachGuidanceMaterial(
  view: EditorView,
  target: GuidanceTarget,
  path: string,
  purpose?: string,
): boolean {
  const uri = packageUri(path);
  if (!uri) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const prefix = materialKind(path) === "reference" ? "Consult " : "Use ";
  const explanation = intent(purpose);
  const link = schema.marks.link.create({ href: uri });
  const content = [
    view.state.schema.text(prefix),
    view.state.schema.text(name, [link]),
    view.state.schema.text(` to ${explanation}${end(explanation)}`),
  ];
  return appendToTarget(view, target, content, explanation === "…" ? prefix.length + name.length + 4 : null);
}

export function attachGuidanceSkill(
  view: EditorView,
  target: GuidanceTarget,
  pick: Pick,
  purpose?: string,
): boolean {
  const prefix = "Consult the ";
  const explanation = intent(purpose);
  const chip = schema.nodes.skill_ref.create({
    name: pick.name,
    role: "when-relevant",
    from: pick.from ? JSON.stringify(pick.from) : null,
  });
  const content = [
    view.state.schema.text(prefix),
    chip,
    view.state.schema.text(` when ${explanation}${end(explanation)}`),
  ];
  return appendToTarget(
    view,
    target,
    content,
    explanation === "…" ? prefix.length + chip.nodeSize + 6 : null,
  );
}
