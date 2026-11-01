import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { type ReactNode, useEffect, useId, useReducer, useState } from "react";
import type { CanvasConnection } from "./canvasConnections";
import { disconnectConnection, instructionTargets, moveConnection } from "./connectionEditing";
import { selectedGuidance, subscribeGuidance } from "./guidanceContext";

/** Blank paragraphs are insertion points, not instructions needing support. */
function supportTarget(view: EditorView) {
  const target = selectedGuidance(view.state);
  const node = target ? view.state.doc.nodeAt(target.from) : null;
  return node?.textBetween(0, node.content.size, " ", "\ufffc").trim() ? target : null;
}

/** A persistent work tray: choices stay in sight, and fold away when writing. */
export function StudioPalette({
  view,
  steps,
  support,
  onStructure,
  onLiftStructure,
}: {
  view?: EditorView | null;
  steps?: ReactNode;
  support?: ReactNode;
  onStructure?: (kind: "heading" | "divider") => void;
  onLiftStructure?: (kind: "heading" | "divider", event: PointerEvent) => void;
}) {
  const [selected, setSelected] = useState("steps");
  const [canvasActive, setCanvasActive] = useState(false);
  const [connection, setConnection] = useState<{
    connection: CanvasConnection;
    from: number;
    doc: PMNode;
    inspect: () => void;
    lift: (event: PointerEvent) => void;
  } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => (view ? subscribeGuidance(view, refresh) : undefined), [view]);
  const current = canvasActive && view && steps ? supportTarget(view) : null;
  useEffect(() => {
    if (!view) return;
    let lastFrom = -1;
    const activate = () => {
      const guidance = supportTarget(view);
      setCanvasActive(!!guidance);
      setSelected(guidance ? "support" : "steps");
      setConnection(null);
      lastFrom = view.state.selection.from;
    };
    const focus = () => activate();
    const pointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".studio-footer-palette, .canvas-inline-connection")) return;
      if (view.dom.contains(target) && target.closest("p")) {
        requestAnimationFrame(() => {
          if (!view.isDestroyed) activate();
        });
      } else if (view.dom.closest(".sk-stage")?.contains(target) || target === view.dom) {
        setCanvasActive(false);
        setConnection(null);
        setSelected("steps");
      }
    };
    const selectionRelease = subscribeGuidance(view, () => {
      if (view.hasFocus() && view.state.selection.from !== lastFrom) activate();
    });
    view.dom.addEventListener("focus", focus);
    document.addEventListener("pointerdown", pointer);
    const open = (event: Event) => {
      setCanvasActive(true);
      setConnection(null);
      setSelected((event as CustomEvent<string>).detail);
      setExpanded(true);
    };
    const connect = (event: Event) => {
      setCanvasActive(true);
      setConnection((event as CustomEvent).detail);
      setSelected("support");
      setExpanded(true);
    };
    const release = subscribeGuidance(view, () =>
      setConnection((current) => (current && current.doc !== view.state.doc ? null : current)),
    );
    view.dom.addEventListener("habi-palette", open);
    view.dom.addEventListener("habi-connection-tools", connect);
    return () => {
      release();
      selectionRelease();
      view.dom.removeEventListener("focus", focus);
      document.removeEventListener("pointerdown", pointer);
      view.dom.removeEventListener("habi-palette", open);
      view.dom.removeEventListener("habi-connection-tools", connect);
    };
  }, [view]);
  const groups = [
    { key: "steps", label: "Steps", glyph: "✳", content: steps },
    { key: "support", label: "Support", glyph: "⌁", content: current || connection ? support : undefined },
  ].filter((group) => group.content);
  const active = groups.find((group) => group.key === selected) ?? groups[0];
  if (!active) return null;
  return (
    <section className={`studio-footer-palette${expanded ? " is-expanded" : ""}`} aria-label="Studio palette">
      <header>
        <button
          type="button"
          className="studio-palette-badge"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? "Collapse palette" : "Expand palette"}
          title={expanded ? "Collapse palette" : "Expand palette"}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="studio-palette-badge-mark" aria-hidden="true">
            ≋
          </span>
          <span>Your palette</span>
          <span className="studio-palette-badge-chevron" aria-hidden="true">
            {expanded ? "⌄" : "⌃"}
          </span>
        </button>
        <nav aria-label="Palette tools">
          {onStructure && steps ? (
            <>
              <button
                type="button"
                className="studio-structure-tool"
                title="Drag between steps, or click to add"
                onPointerDown={(event) => onLiftStructure?.("heading", event.nativeEvent)}
                onClick={() => onStructure("heading")}
              >
                <span aria-hidden="true">H₂</span>Heading
              </button>
              <button
                type="button"
                className="studio-structure-tool"
                title="Drag between steps, or click to add"
                onPointerDown={(event) => onLiftStructure?.("divider", event.nativeEvent)}
                onClick={() => onStructure("divider")}
              >
                <span aria-hidden="true">—</span>Divider
              </button>
              <span className="studio-palette-separator" aria-hidden="true" />
            </>
          ) : null}
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`is-${group.key}`}
              aria-pressed={active.key === group.key}
              onClick={() => {
                setConnection(null);
                setSelected(group.key);
                setExpanded(true);
              }}
            >
              <span aria-hidden="true">{group.glyph}</span>
              {group.label}
            </button>
          ))}
        </nav>
      </header>
      <div id={id} className={`studio-footer-tools is-${active.key}`} hidden={!expanded}>
        {connection && view && active.key === "support" ? (
          <fieldset
            className="studio-connection-tools"
            aria-label={`${connection.connection.name} connection`}
          >
            <div>
              <small>{connection.connection.label}</small>
              <strong>{connection.connection.name}</strong>
              <span>{connection.connection.purpose}</span>
            </div>
            <button type="button" onClick={connection.inspect}>
              Open
            </button>
            <button type="button" onPointerDown={(event) => connection.lift(event.nativeEvent)}>
              ⠿ Drag to a step
            </button>
            <select
              aria-label={`Move ${connection.connection.name} to another step`}
              value=""
              onChange={(event) => {
                if (event.target.value)
                  moveConnection(view, connection.connection, Number(event.target.value));
              }}
            >
              <option value="">Move to…</option>
              {instructionTargets(view.state.doc)
                .filter((target) => target.from !== connection.from)
                .map((target) => (
                  <option key={target.from} value={target.from}>
                    {target.label}
                  </option>
                ))}
            </select>
            <button type="button" onClick={() => disconnectConnection(view, connection.connection)}>
              Disconnect
            </button>
            <button type="button" onClick={() => setConnection(null)}>
              Done
            </button>
          </fieldset>
        ) : (
          active.content
        )}
      </div>
    </section>
  );
}
