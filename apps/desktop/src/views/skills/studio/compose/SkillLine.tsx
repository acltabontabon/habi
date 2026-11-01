/**
 * What sits between a skill's purpose and its instructions: one sentence about
 * when it's used, and the files that come with it as things you can pick up.
 * Drag one into the instructions to say what it's for. A file the words don't
 * mention yet looks unfinished, because for an agent it nearly doesn't exist.
 */
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../../../components/Icon";
import { KIND_GLYPH, KIND_NAME, type Material } from "../../../../lib/materials";

const SHOWN = 6;

function whenWords(when: string | null): { lead: string; words: string; tail: string } {
  if (when === null) return { lead: "", words: "You bring this in when you want it", tail: "." };
  if (when === "Needs attention")
    return { lead: "", words: "Its rules for when to suggest it need attention", tail: "." };
  if (when === "Written as YAML")
    return { lead: "Habi suggests it ", words: "by rules written by hand", tail: "." };
  return { lead: "Habi suggests it when ", words: when, tail: "." };
}

export function SkillLine({
  when,
  materials,
  readOnly,
  onWhen,
  onPeek,
  onLift,
  onAddFile,
  onAllFiles,
  children,
}: {
  when: string | null;
  materials: Material[];
  readOnly: boolean;
  onWhen: () => void;
  onPeek: (path: string, rect: DOMRect) => void;
  onLift: (material: Material, event: PointerEvent) => void;
  onAddFile: () => void;
  onAllFiles: () => void;
  /** What the rules mean for the author's own projects, right after the rules. */
  children?: ReactNode;
}) {
  const said = whenWords(when);
  const extra = materials.length - SHOWN;
  return (
    <div className="sk-line">
      <p className="sk-line-when">
        {said.lead}
        <button type="button" onClick={onWhen} title="Choose when Habi suggests it">
          {said.words}
        </button>
        {said.tail}
      </p>
      {children}
      <ul className="sk-files" aria-label="Files that come with it">
        {materials.slice(0, SHOWN).map((m) => (
          <li key={m.path}>
            <button
              type="button"
              className={`sk-file${m.referenced ? "" : " is-loose"}`}
              title={
                m.referenced
                  ? `${KIND_NAME[m.kind].one}. Click to look inside.`
                  : `${KIND_NAME[m.kind].one}. The instructions don't mention it yet: drag it to where it belongs.`
              }
              onPointerDown={(e: ReactPointerEvent) => {
                if (!readOnly) onLift(m, e.nativeEvent);
              }}
              onClick={(e) => onPeek(m.path, e.currentTarget.getBoundingClientRect())}
            >
              <span className="sk-file-glyph" aria-hidden="true">
                {KIND_GLYPH[m.kind]}
              </span>
              {m.name}
            </button>
          </li>
        ))}
        {extra > 0 ? (
          <li>
            <button type="button" className="sk-file-more" onClick={onAllFiles}>
              {extra} more
            </button>
          </li>
        ) : null}
        {!readOnly ? (
          <li>
            <button
              type="button"
              className="sk-file-more"
              onClick={onAddFile}
              title="Add a file to this skill"
            >
              <Icon name="plus" size={12} /> {materials.length ? "File" : "Add a file"}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
