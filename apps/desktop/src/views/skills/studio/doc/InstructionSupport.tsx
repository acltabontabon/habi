/** The active instruction's support, in reach without turning every paragraph into a card. */
import type { EditorView } from "prosemirror-view";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { KIND_GLYPH, KIND_NAME } from "../../../../lib/materials";
import { occurrencesIn } from "../compose/roles";
import {
  captureGuidanceTarget,
  type GuidanceTarget,
  selectedGuidance,
  subscribeGuidance,
} from "./guidanceContext";
import { listMaterialUses } from "./materialUses";

/** Show the connected instruction's actual intent clause, without repeating its whole text. */
function purposeAfter(view: EditorView, from: number, to: number, fallback: string): string {
  const tail = view.state.doc.textBetween(from, to, " ");
  const clause = /^\s*((?:to|when|for|if|as)\s+.*?)(?:[.!?](?:\s|$)|$)/i.exec(tail)?.[1];
  const text = clause ?? fallback;
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

export function GuidanceContext({
  view,
  paths,
  readOnly = false,
  skillTitle = (name) => name.replace(/-/g, " "),
  onCreateScript,
  onCreateReference,
  onChooseMaterial,
  onWeaveSkill,
  onInspectMaterial,
  onInspectSkill,
  onClose,
  initiallyExpanded = false,
}: {
  onClose?: () => void;
  initiallyExpanded?: boolean;
  view: EditorView | null;
  paths: readonly string[];
  readOnly?: boolean;
  skillTitle?: (name: string) => string;
  onCreateScript: (target: GuidanceTarget) => void;
  onCreateReference: (target: GuidanceTarget) => void;
  onChooseMaterial: (target: GuidanceTarget) => void;
  onWeaveSkill: (target: GuidanceTarget) => void;
  onInspectMaterial: (path: string) => void;
  onInspectSkill: (name: string, pos: number) => void;
}) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const contentId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => (view ? subscribeGuidance(view, refresh) : undefined), [view]);
  const selected = view ? selectedGuidance(view.state) : null;
  const materials =
    view && selected
      ? listMaterialUses(view.state.doc, paths).filter(
          (use) => use.from > selected.from && use.to < selected.to,
        )
      : [];
  const skills =
    view && selected
      ? occurrencesIn(view.state.doc).filter((use) => use.pos > selected.from && use.pos < selected.to)
      : [];
  const begin = (act: (target: GuidanceTarget) => void) => {
    if (!view || readOnly) return;
    const target = captureGuidanceTarget(view);
    if (target) {
      setExpanded(false);
      act(target);
    }
  };
  return (
    <aside
      className={`guidance-context${expanded ? " is-expanded" : ""}`}
      aria-label="Support this instruction"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="guidance-context-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Support this instruction</span>
        <small>{selected?.location ?? "Choose an instruction"}</small>
      </button>
      <div id={contentId} className="guidance-context-content">
        <header className="guidance-context-heading">
          <span>{selected?.location ?? "Instruction context"}</span>
          <h3>Support this instruction</h3>
          {onClose && (
            <button
              type="button"
              className="guidance-context-close"
              onClick={onClose}
              aria-label="Close instruction support"
            >
              ×
            </button>
          )}
        </header>
        {selected ? (
          <>
            <blockquote className="guidance-context-quote">
              {selected.label.length > 180 ? `${selected.label.slice(0, 177)}…` : selected.label}
            </blockquote>
            {materials.length || skills.length ? (
              <ul className="guidance-contributions" aria-label="Support used here">
                {materials.map((use) => (
                  <li key={`material:${use.from}`}>
                    <button
                      type="button"
                      className={`guidance-contribution is-${use.materialKind}`}
                      onClick={() => {
                        setExpanded(false);
                        onInspectMaterial(use.path);
                      }}
                    >
                      <span className="guidance-contribution-kind">
                        <span aria-hidden="true">{KIND_GLYPH[use.materialKind]}</span>{" "}
                        {KIND_NAME[use.materialKind].one}
                        {use.missing ? " · missing" : ""}
                      </span>
                      <span className="guidance-contribution-name">{use.path}</span>
                      <span className="guidance-contribution-purpose">
                        {view ? purposeAfter(view, use.to, selected.to - 1, use.context) : use.context}
                      </span>
                    </button>
                  </li>
                ))}
                {skills.map((use) => (
                  <li key={`skill:${use.pos}`}>
                    <button
                      type="button"
                      className="guidance-contribution is-skill"
                      onClick={() => {
                        setExpanded(false);
                        onInspectSkill(use.name, use.pos);
                      }}
                    >
                      <span className="guidance-contribution-kind">
                        {use.role === null ? "Mentioned skill" : "Skill expertise"}
                      </span>
                      <span className="guidance-contribution-name">{skillTitle(use.name)}</span>
                      <span className="guidance-contribution-purpose">
                        {view
                          ? purposeAfter(view, use.pos + 1, selected.to - 1, selected.label)
                          : selected.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="guidance-context-empty">Add a tool, knowledge, or expertise where it helps.</p>
            )}
            {!readOnly ? (
              <div className="guidance-context-actions">
                <button type="button" onClick={() => begin(onCreateScript)}>
                  Add script
                </button>
                <button type="button" onClick={() => begin(onCreateReference)}>
                  Create reference
                </button>
                <button type="button" onClick={() => begin(onChooseMaterial)}>
                  Use existing material
                </button>
                <button type="button" onClick={() => begin(onWeaveSkill)}>
                  Weave skill
                </button>
              </div>
            ) : null}
            <p className="guidance-context-truth">
              Connections add guidance. Nothing runs or loads automatically.
            </p>
          </>
        ) : (
          <p className="guidance-context-empty">Select instruction text to connect support.</p>
        )}
      </div>
    </aside>
  );
}
