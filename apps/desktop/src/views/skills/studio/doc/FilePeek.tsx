/**
 * A look at one of the skill's files without leaving the sentence that names it.
 * Text is shown, never run: Markdown through the app's sanitizing reader, scripts
 * and data as plain text. A named file that isn't there can be made here.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Markdown } from "../../../../components/lazy";
import { Button } from "../../../../components/ui";
import { api } from "../../../../lib/api";
import { sizeLabel } from "../../../../lib/format";
import { KIND_NAME, materialKind } from "../../../../lib/materials";

export type PeekTarget = {
  path: string;
  rect: { left: number; top: number; bottom: number };
  absent: boolean;
};

const PREVIEW_CHARS = 2400;

export function FilePeek({
  skillId,
  target,
  executable,
  onOpen,
  onCreate,
  onClose,
}: {
  skillId: string;
  target: PeekTarget;
  executable: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const file = useQuery({
    queryKey: ["skill-file-peek", skillId, target.path],
    queryFn: () => api.readSkillFile(skillId, target.path),
    enabled: !target.absent,
    staleTime: 2000,
  });

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);

  const name = target.path.slice(target.path.lastIndexOf("/") + 1);
  const kind = KIND_NAME[materialKind(target.path, executable)].one;
  const below = target.rect.bottom + 340 < window.innerHeight;
  const left = Math.min(Math.max(16, target.rect.left - 12), window.innerWidth - 436);
  const style = below
    ? { left, top: target.rect.bottom + 8 }
    : { left, bottom: window.innerHeight - target.rect.top + 8 };
  const data = file.data;
  const markdown = /\.(md|markdown|mdx)$/i.test(target.path);
  const text = data?.text ?? null;
  const cut = text !== null && text.length > PREVIEW_CHARS;
  const shown = cut ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in it closes it.
    <div
      ref={root}
      className="file-peek"
      style={style}
      role="dialog"
      aria-label={name}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="file-peek-head">
        <div>
          <h3>{name}</h3>
          <p>
            {target.absent ? "Not in this skill yet" : `${kind}${data ? ` · ${sizeLabel(data.size)}` : ""}`}
          </p>
        </div>
        {target.absent ? (
          <Button onClick={() => onCreate(target.path)}>Create it</Button>
        ) : (
          <Button onClick={() => onOpen(target.path)}>Open</Button>
        )}
      </header>
      {target.absent ? (
        <p className="file-peek-note">
          The instructions name <code>{target.path}</code>, so an agent will look for it. Create it here, or
          change the words if it was meant to be something else.
        </p>
      ) : file.isLoading ? null : file.isError ? (
        <p className="file-peek-note">This file can't be shown here.</p>
      ) : data?.preview ? (
        <div className="file-peek-picture">
          <img src={data.preview} alt={`Preview of ${name}`} />
        </div>
      ) : shown === null ? (
        <p className="file-peek-note">Not a text file. It's kept in the skill exactly as it is.</p>
      ) : markdown ? (
        <div className="file-peek-body is-prose">
          <Markdown text={shown} />
        </div>
      ) : (
        <pre className="file-peek-body">{shown}</pre>
      )}
      {!target.absent && !markdown && !data?.preview && shown !== null && executable ? (
        <p className="file-peek-note">
          An agent may inspect or run this, depending on the instructions and its permissions. Habi doesn't
          run it.
        </p>
      ) : null}
    </div>
  );
}
