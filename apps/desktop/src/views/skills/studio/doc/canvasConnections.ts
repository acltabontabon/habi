/** Visible threads derived from the document: never a second graph to keep in sync. */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { KIND_NAME } from "../../../../lib/materials";
import { occurrencesIn, roleInfo } from "../compose/roles";
import { disconnectConnection, instructionTargets, moveConnection } from "./connectionEditing";
import { armDrag, ghostLabel } from "./drag";
import { listMaterialUses } from "./materialUses";
import { LOOKS_CHANGED, type ViewContext } from "./nodeViews";

export type CanvasConnection = {
  kind: string;
  label: string;
  name: string;
  purpose: string;
  pos: number;
  end: number;
  path?: string;
  skill?: string;
  missing: boolean;
  unsure?: boolean;
};
export type CanvasThread = { from: number; to: number; location: string; connections: CanvasConnection[] };

export function canvasThreads(
  doc: PMNode,
  paths: readonly string[],
  context: ViewContext = {},
): CanvasThread[] {
  const groups = new Map<number, CanvasThread>();
  const group = (pos: number) => {
    const $pos = doc.resolve(pos);
    if ($pos.parent.type.name !== "paragraph") return null;
    const from = $pos.before();
    let current = groups.get(from);
    if (!current) {
      let location = "instruction";
      for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).type.name === "list_item" && $pos.node(depth - 1).type.name === "ordered_list") {
          location = `step ${Number($pos.node(depth - 1).attrs.start) + $pos.index(depth - 1)}`;
          break;
        }
      }
      current = { from, to: from + $pos.parent.nodeSize, location, connections: [] };
      groups.set(from, current);
    }
    return current;
  };
  const purpose = (end: number, to: number, fallback: string) => {
    const tail = doc.textBetween(end, to - 1, " ");
    const clause = /^\s*((?:to|when|for|if|as)\s+.*?)(?:[.!?](?:\s|$)|$)/i.exec(tail)?.[1];
    return clause?.trim() || fallback;
  };
  for (const use of listMaterialUses(doc, paths)) {
    const target = group(use.from);
    if (!target) continue;
    target.connections.push({
      kind: use.materialKind,
      label: KIND_NAME[use.materialKind].one,
      name: use.path.split("/").pop() || use.path,
      path: use.path,
      pos: use.from,
      end: use.to,
      purpose: purpose(use.to, target.to, "Referenced in this instruction"),
      missing: use.missing,
    });
  }
  for (const use of occurrencesIn(doc)) {
    const target = group(use.pos);
    if (!target) continue;
    const look = context.skillLook?.(use.name, use.role);
    target.connections.push({
      kind: "skill",
      label: use.role === null ? "Skill mention" : "Skill expertise",
      name: look?.title ?? use.name.replace(/-/g, " "),
      skill: use.name,
      pos: use.pos,
      end: use.pos + 1,
      purpose: purpose(use.pos + 1, target.to, roleInfo(use.role)?.label ?? "Mentioned in this instruction"),
      missing: look?.status === "missing",
      unsure: look?.status === "unsure",
    });
  }
  return [...groups.values()]
    .sort((a, b) => a.from - b.from)
    .map((thread) => ({ ...thread, connections: thread.connections.sort((a, b) => a.pos - b.pos) }));
}

export function canvasConnectionsPlugin(
  paths: () => readonly string[],
  context: () => ViewContext,
  openFile: (path: string) => void,
  paletteTools = false,
) {
  return new Plugin({
    view(view) {
      const refresh = () => view.dispatch(view.state.tr.setMeta("canvas-connections-refresh", true));
      const close = (event: PointerEvent) => {
        for (const root of view.dom.querySelectorAll<HTMLElement>(".canvas-inline-connection")) {
          if (root.contains(event.target as Node)) continue;
          root.querySelector<HTMLElement>(".canvas-connection-menu")?.setAttribute("hidden", "");
          root.querySelector("button")?.setAttribute("aria-expanded", "false");
        }
      };
      view.dom.addEventListener(LOOKS_CHANGED, refresh);
      document.addEventListener("pointerdown", close);
      return {
        update: (current) => {
          for (const control of current.dom.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
            "[data-connection-control]",
          ))
            control.disabled = !current.editable;
        },
        destroy: () => {
          view.dom.removeEventListener(LOOKS_CHANGED, refresh);
          document.removeEventListener("pointerdown", close);
        },
      };
    },
    props: {
      decorations(state) {
        return DecorationSet.create(
          state.doc,
          canvasThreads(state.doc, paths(), context()).flatMap((thread) =>
            thread.connections.map((connection) =>
              Decoration.widget(
                connection.end,
                (view) => {
                  const root = document.createElement("span");
                  root.className = "canvas-inline-connection";
                  root.contentEditable = "false";
                  const toggle = document.createElement("button");
                  toggle.type = "button";
                  toggle.className = "canvas-connection-toggle";
                  toggle.textContent = "⋯";
                  toggle.title = `Options for ${connection.name}. Drag to another step.`;
                  toggle.setAttribute("aria-label", `Connection options for ${connection.name}`);
                  toggle.setAttribute("aria-expanded", "false");
                  const actions = document.createElement("span");
                  actions.className = "canvas-connection-menu";
                  actions.setAttribute("role", "group");
                  actions.setAttribute("aria-label", `${connection.name} connection`);
                  actions.hidden = true;
                  toggle.addEventListener("mousedown", (event) => event.preventDefault());
                  toggle.addEventListener("click", () => {
                    if (paletteTools) {
                      view.dispatch(
                        view.state.tr.setSelection(
                          TextSelection.near(view.state.doc.resolve(connection.pos)),
                        ),
                      );
                      view.dom.dispatchEvent(
                        new CustomEvent("habi-connection-tools", {
                          detail: {
                            connection,
                            from: thread.from,
                            doc: view.state.doc,
                            inspect: () => inspect.click(),
                            lift,
                          },
                        }),
                      );
                      return;
                    }
                    actions.hidden = !actions.hidden;
                    toggle.setAttribute("aria-expanded", String(!actions.hidden));
                    if (!actions.hidden) {
                      const rect = toggle.getBoundingClientRect();
                      const stage = view.dom.closest(".sk-stage")?.getBoundingClientRect();
                      const width = actions.offsetWidth;
                      const height = actions.offsetHeight;
                      actions.style.left = `${Math.max((stage?.left ?? 0) + 8, Math.min(rect.left, window.innerWidth - width - 12))}px`;
                      actions.style.top = `${rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6}px`;
                    }
                  });
                  root.addEventListener("keydown", (event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      actions.hidden = true;
                      toggle.setAttribute("aria-expanded", "false");
                      toggle.focus();
                    }
                  });
                  const lift = (event: PointerEvent) => {
                    if (!view.editable) return;
                    armDrag(event, () => {
                      const source = view.state.doc;
                      actions.hidden = true;
                      toggle.setAttribute("aria-expanded", "false");
                      return {
                        view,
                        ghost: ghostLabel(connection.name),
                        instructions: true,
                        instructionsOnly: true,
                        onLand: (landing) => {
                          if (landing.type === "instruction" && view.state.doc === source)
                            moveConnection(view, connection, landing.pos);
                        },
                      };
                    });
                  };
                  toggle.addEventListener("pointerdown", lift);
                  const inspect = document.createElement("button");
                  inspect.type = "button";
                  inspect.textContent = "Open";
                  inspect.setAttribute(
                    "aria-label",
                    `Inspect ${connection.label}: ${connection.name}. ${connection.purpose}`,
                  );
                  inspect.addEventListener("click", () => {
                    const rect = toggle.getBoundingClientRect();
                    actions.hidden = true;
                    toggle.setAttribute("aria-expanded", "false");
                    view.dispatch(
                      view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(connection.pos))),
                    );
                    if (connection.skill) context().onSkillClick?.(connection.skill, connection.pos, rect);
                    else if (connection.path) {
                      if (context().onFileClick)
                        context().onFileClick?.(connection.path, rect, connection.missing);
                      else openFile(connection.path);
                    }
                  });
                  const handle = document.createElement("button");
                  handle.type = "button";
                  handle.textContent = "⠿ Drag";
                  handle.setAttribute("aria-label", `Drag ${connection.name} to another step`);
                  handle.addEventListener("pointerdown", lift);
                  const move = document.createElement("select");
                  move.setAttribute("aria-label", `Move ${connection.name} to another step`);
                  const prompt = document.createElement("option");
                  prompt.textContent = "Move to…";
                  prompt.value = "";
                  move.append(prompt);
                  for (const target of instructionTargets(view.state.doc)) {
                    if (target.from === thread.from) continue;
                    const option = document.createElement("option");
                    option.value = String(target.from);
                    option.textContent = target.label;
                    move.append(option);
                  }
                  move.addEventListener("change", () => {
                    if (move.value) moveConnection(view, connection, Number(move.value));
                  });
                  const disconnect = document.createElement("button");
                  disconnect.type = "button";
                  disconnect.textContent = "Disconnect";
                  disconnect.setAttribute("aria-label", `Disconnect ${connection.name} from this step`);
                  disconnect.addEventListener("click", () => disconnectConnection(view, connection));
                  for (const control of [handle, move, disconnect]) {
                    control.disabled = !view.editable;
                    control.dataset.connectionControl = "true";
                  }
                  actions.append(inspect, handle, move, disconnect);
                  root.append(document.createTextNode("\u2060"), toggle, actions);
                  return root;
                },
                {
                  side: -1,
                  key: `connection:${JSON.stringify(connection)}:${JSON.stringify(instructionTargets(state.doc))}`,
                  stopEvent: () => true,
                },
              ),
            ),
          ),
        );
      },
    },
  });
}
