/** A shared canvas palette, with reusable plain-language forms for alternate entry points. */
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useId, useRef, useState } from "react";
import {
  ADD_GUIDANCE,
  type AuthoredCapability,
  blocksForMarkdown,
  CAPABILITY_PIECES,
  type CapabilityKind,
  type CapabilityPiece,
  insertCanvasPiece,
  insertionAtSelection,
} from "./capabilityPieces";
import { ghostLabel } from "./drag";
import { markdownForFile } from "./fileRefs";
import { placeBlocks } from "./moves";

export type InsertionTarget = { pos: number; left?: number; top?: number };

const FIELD_LABELS: Record<CapabilityKind, string> = {
  instruction: "What should the agent do?",
  procedure: "Steps",
  condition: "What should the agent do then?",
  constraint: "What rule must the agent follow?",
  example: "Show an example",
  result: "What should the response contain?",
};

const FIELD_EXAMPLES: Record<CapabilityKind, string> = {
  instruction: "e.g. Turn meeting notes into decisions, action items, and open questions.",
  procedure: "",
  condition: "e.g. Check that authentication errors never reveal private information.",
  constraint: "e.g. Ask before deleting files or changing shared settings.",
  example: "e.g. Action: Send the revised proposal · Owner: Alex · Due: Friday",
  result: "e.g. A short summary followed by a checklist of next steps.",
};

/** A real authoring surface: field values become literal document content only on submit. */
export function CapabilityForm({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: CapabilityKind;
  onSubmit: ((values: AuthoredCapability) => boolean) | ((values: AuthoredCapability) => void);
  onCancel?: () => void;
}) {
  const [content, setContent] = useState("");
  const [when, setWhen] = useState("");
  const [steps, setSteps] = useState([""]);
  const [code, setCode] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const piece = CAPABILITY_PIECES.find((item) => item.kind === kind);
  const valid =
    kind === "procedure"
      ? steps.every((step) => step.trim())
      : !!content.trim() && (kind !== "condition" || !!when.trim());
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("textarea, input")?.focus();
  }, []);
  return (
    <form
      ref={form}
      className="capability-compose-form"
      aria-label={`New ${piece?.label.toLowerCase() ?? "instruction"}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || submitted) return;
        if (onSubmit({ content, when, steps, code }) !== false) setSubmitted(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onCancel) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      {kind === "condition" ? (
        <label className="capability-compose-field" htmlFor={`${id}-when`}>
          <span>When does this apply?</span>
          <input
            id={`${id}-when`}
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            placeholder="Authentication-related code changes"
            required
            autoComplete="off"
          />
        </label>
      ) : null}
      {kind === "procedure" ? (
        <div className="capability-compose-steps">
          <p className="capability-compose-hint">Give the agent a repeatable approach, one step at a time.</p>
          {steps.map((step, index) => (
            <div key={index} className="capability-compose-step">
              <label className="capability-compose-field" htmlFor={`${id}-step-${index}`}>
                <span>Step {index + 1}</span>
                <textarea
                  id={`${id}-step-${index}`}
                  rows={2}
                  placeholder={
                    index === 0
                      ? "Start with the first action, e.g. Read the notes and identify decisions."
                      : "What should happen next?"
                  }
                  value={step}
                  onChange={(event) =>
                    setSteps((current) =>
                      current.map((value, at) => (at === index ? event.target.value : value)),
                    )
                  }
                  required
                />
              </label>
              {steps.length > 1 ? (
                <button
                  type="button"
                  className="link-btn"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => setSteps((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setSteps((current) => [...current, ""]);
              requestAnimationFrame(() =>
                form.current
                  ?.querySelector<HTMLTextAreaElement>(".capability-compose-step:last-of-type textarea")
                  ?.focus(),
              );
            }}
          >
            Add step
          </button>
        </div>
      ) : (
        <label className="capability-compose-field" htmlFor={`${id}-content`}>
          <span>{FIELD_LABELS[kind]}</span>
          <textarea
            id={`${id}-content`}
            rows={kind === "example" ? 6 : 4}
            placeholder={code ? "Paste your example code here" : FIELD_EXAMPLES[kind]}
            className={code ? "is-code" : undefined}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            required
          />
        </label>
      )}
      {kind === "example" ? (
        <label className="capability-compose-check">
          <input type="checkbox" checked={code} onChange={(event) => setCode(event.target.checked)} />
          This is a code example
        </label>
      ) : null}
      <div className="capability-compose-actions">
        {onCancel ? (
          <button type="button" className="link-btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="button primary" disabled={!valid || submitted}>
          Add {piece?.label.toLowerCase() ?? "instruction"}
        </button>
      </div>
    </form>
  );
}

export function Pieces({
  view,
  files,
  onChoose,
  landInto,
  target,
  onTarget,
}: {
  view: EditorView;
  files: () => { path: string; name: string; referenced: boolean }[];
  onChoose: (what: "skill" | "file") => void;
  landInto: (event: PointerEvent, ghost: HTMLElement, land: (at: number) => void) => void;
  target: InsertionTarget | null;
  onTarget: (target: InsertionTarget | null) => void;
}) {
  const [resources, setResources] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    onTarget(null);
    setResources(false);
    view.focus();
  };

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string }>).detail;
      const piece = CAPABILITY_PIECES.find((item) => item.kind === detail?.kind);
      const at = insertionAtSelection(view);
      setResources(false);
      if (piece?.kind) {
        onTarget(null);
        insertCanvasPiece(view, at, piece.kind);
      } else onTarget({ pos: at });
    };
    view.dom.addEventListener(ADD_GUIDANCE, open);
    return () => view.dom.removeEventListener(ADD_GUIDANCE, open);
  }, [view, onTarget]);

  useEffect(() => {
    if (!target) {
      setResources(false);
      return;
    }
    menu.current
      ?.querySelector<HTMLButtonElement>(resources ? ".sk-file, .sk-file-more" : ".capability-option")
      ?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        onTarget(null);
        setResources(false);
      }
    };
    const typing = () => {
      onTarget(null);
      setResources(false);
    };
    window.addEventListener("pointerdown", away);
    view.dom.addEventListener("keydown", typing);
    return () => {
      window.removeEventListener("pointerdown", away);
      view.dom.removeEventListener("keydown", typing);
    };
  }, [target, resources, onTarget, view]);

  const choose = (what: "skill" | "file", at: number) => {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at), -1)));
    onTarget(null);
    setResources(false);
    view.focus();
    onChoose(what);
  };
  const insert = (piece: CapabilityPiece, at: number) => {
    if (piece.kind) {
      onTarget(null);
      insertCanvasPiece(view, at, piece.kind);
    } else if (piece.choose === "file") setResources(true);
    else if (piece.choose) choose(piece.choose, at);
  };
  const fixed = target?.left !== undefined && target.top !== undefined;
  const style = fixed
    ? {
        position: "fixed" as const,
        left: Math.max(
          20,
          Math.min(target.left ?? 20, window.innerWidth - Math.min(470, window.innerWidth - 40) - 20),
        ),
        top: Math.max(
          12,
          Math.min(target.top ?? 12, window.innerHeight - Math.min(560, window.innerHeight * 0.7) - 20),
        ),
      }
    : undefined;

  return (
    <div ref={root} className="doc-tray capability-tray">
      <button
        type="button"
        className="capability-add"
        aria-keyshortcuts="Control+Shift+I Meta+Shift+I"
        title="Add guidance after the selected instruction"
        aria-expanded={!!target}
        aria-controls={target ? id : undefined}
        onClick={() => (target ? close() : onTarget({ pos: insertionAtSelection(view) }))}
      >
        <span aria-hidden="true">+</span> Add guidance
      </button>
      {target ? (
        <div
          ref={menu}
          id={id}
          className={`capability-menu${fixed ? " is-contextual" : ""}`}
          style={style}
          role="dialog"
          aria-label={resources ? "Attach a resource" : "Add guidance"}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
              !(event.target as HTMLElement).matches("input, textarea, select")
            ) {
              const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              event.preventDefault();
              buttons[next]?.focus();
            }
          }}
        >
          <div className="capability-menu-head">
            <span>{resources ? "Supporting resources" : "Shape this capability"}</span>
            <button type="button" aria-label="Close guidance choices" onClick={close}>
              ×
            </button>
          </div>
          {resources ? (
            <div className="capability-files">
              {files().map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="sk-file"
                  onPointerDown={(event) =>
                    landInto(event.nativeEvent, ghostLabel(file.name), (at) => {
                      onTarget(null);
                      setResources(false);
                      placeBlocks(view, at, blocksForMarkdown(markdownForFile(file.path)));
                    })
                  }
                  onClick={() => {
                    onTarget(null);
                    setResources(false);
                    placeBlocks(view, target.pos, blocksForMarkdown(markdownForFile(file.path)));
                  }}
                >
                  {file.name}
                </button>
              ))}
              <button type="button" className="sk-file-more" onClick={() => choose("file", target.pos)}>
                Create or bring material…
              </button>
            </div>
          ) : (
            <div className="capability-options">
              {CAPABILITY_PIECES.map((piece) => (
                <button
                  type="button"
                  key={piece.id}
                  className={`capability-option is-${piece.id}`}
                  onClick={() => insert(piece, target.pos)}
                  onPointerDown={
                    piece.kind
                      ? (event) =>
                          landInto(event.nativeEvent, ghostLabel(piece.label), (at) => insert(piece, at))
                      : undefined
                  }
                >
                  <span className="capability-option-label">{piece.label}</span>
                  <span className="capability-option-hint">{piece.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
