/** Material authoring stays beside the guidance, using the existing package editor. */
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../../components/Icon";
import { Button, ErrorNotice } from "../../../../components/ui";
import { api } from "../../../../lib/api";
import { KIND_NAME, materialKind } from "../../../../lib/materials";
import type { DocEditorHandle } from "../doc/lazy";
import type { SkillDraft } from "../useSkillDraft";
import { Materials } from "./Materials";

export type MaterialTarget = { path: string | null; create?: string };

export function MaterialWorkspace({
  draft,
  target,
  editor,
  onTarget,
  onAttach,
  onClose,
  onSource,
  active = true,
}: {
  draft: SkillDraft;
  target: MaterialTarget;
  editor: RefObject<DocEditorHandle | null>;
  onTarget: (target: MaterialTarget) => void;
  onAttach: (path: string, purpose?: string) => void;
  onClose: () => void;
  onSource: () => void;
  active?: boolean;
}) {
  const { skill, trashed } = draft;
  const root = useRef<HTMLElement>(null);
  const [error, setError] = useState<unknown>(null);
  const paths = useMemo(() => skill.files.map((file) => file.path), [skill.files]);
  const missing = target.path !== null && !paths.includes(target.path);
  const entry = skill.files.find((file) => file.path === target.path);
  const kind = target.path ? materialKind(target.path, entry?.executable) : null;

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>(".shelf-close")?.focus();
  }, []);
  const beforeChange = async () => {
    if (!(await draft.flushAll()))
      throw new Error("Save or resolve the pending edits before changing materials.");
  };
  const safely = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await beforeChange();
      await work();
    } catch (cause) {
      setError(cause);
    }
  };
  const close = () =>
    void safely(async () => {
      onClose();
      editor.current?.focus();
    });
  const canCreateText =
    /\.(?:md|markdown|txt|rst|adoc|json|yaml|yml|toml|xml|csv|tsv|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|rb|pl|ps1|sql|html|css)$/i.test(
      target.path ?? "",
    ) || /(?:^|\/)(?:LICENSE|NOTICE|README|Makefile)$/i.test(target.path ?? "");
  return (
    <aside
      ref={root}
      className="material-workspace"
      aria-label="Material workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="shelf-head">
        <div>
          <span className="weave-eyebrow">{kind ? KIND_NAME[kind].one : "Materials"}</span>
          <h2>
            {target.path?.split("/").pop() ??
              (target.create
                ? target.create === "reference"
                  ? "Create a reference"
                  : target.create === "example"
                    ? "Create an example"
                    : target.create === "asset"
                      ? "Create an asset"
                      : "Create a script"
                : "Choose a material")}
          </h2>
          {target.path ? <p className="material-package-path">{target.path}</p> : null}
        </div>
        <button type="button" className="shelf-close" aria-label="Close material workspace" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="material-workspace-body">
        {target.path ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => void safely(async () => onTarget({ path: null }))}
          >
            All materials
          </button>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        {missing ? (
          <section className="material-missing">
            <h3>Not in this package</h3>
            <p>
              The instructions point to this path, but the file isn't here. Choose another material on the
              canvas, edit the reference, or bring in the expected file. Supported text files can also be
              created here.
            </p>
            {!trashed && canCreateText ? (
              <Button
                onClick={() =>
                  void safely(async () => {
                    const fresh = await api.writeSkillFile(draft.id, target.path ?? "", "", null);
                    draft.adopt(fresh, { document: false, metadata: false });
                  })
                }
              >
                Create missing file
              </Button>
            ) : !trashed ? (
              <Button onClick={() => void safely(async () => onTarget({ path: null }))}>
                Bring an existing file
              </Button>
            ) : null}
          </section>
        ) : (
          <Materials
            skill={skill}
            readOnly={trashed}
            active={active}
            source={false}
            contextual
            startWith={target.create}
            path={target.path}
            instructions={draft.document.body}
            beforeChange={beforeChange}
            onSkill={(fresh, path) =>
              draft.adopt(fresh, {
                document: path === "SKILL.md",
                metadata: path === undefined || /^habi\.ya?ml$/.test(path ?? ""),
              })
            }
            onPath={(path) => onTarget({ path })}
            onSource={onSource}
            onReference={onAttach}
            onCreated={onAttach}
            onWhen={onSource}
          />
        )}
      </div>
    </aside>
  );
}
