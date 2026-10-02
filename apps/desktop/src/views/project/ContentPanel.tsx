/** The skill's own content, rendered safely, with its files. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/lazy";
import { ErrorNotice, Notice, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { levelLabel } from "../../lib/format";
import { useItemDetail } from "../../lib/queries";

/** What the author declared and where the terms are; never an interpretation. */
function licenseText(declared: string | null, file: string | null): string {
  if (declared && file) return `${declared} (terms: ${file})`;
  if (declared) return declared;
  if (file) return `not declared in SKILL.md; terms in ${file}`;
  return "none found in the skill or its library";
}

export function FileViewer({
  sourceId,
  itemId,
  path,
  files,
  onLocalLink,
}: {
  sourceId: string;
  itemId: string;
  path: string;
  files?: string[];
  onLocalLink?: (path: string) => void;
}) {
  const file = useQuery({
    queryKey: ["itemFile", sourceId, itemId, path],
    queryFn: () => api.itemFile(sourceId, itemId, path),
  });
  if (file.isPending) return <Working>Loading {path}…</Working>;
  if (file.isError) return <ErrorNotice error={file.error} />;
  if (file.data.binary || file.data.text === null) {
    return (
      <p className="muted">
        {path} is not text ({file.data.size} bytes).
      </p>
    );
  }
  return (
    <div className="file-view">
      <div className="file-view-head mono">{path}</div>
      {path.endsWith(".md") ? (
        <Markdown
          text={file.data.text}
          files={files}
          onLocalLink={onLocalLink}
          base={path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined}
        />
      ) : (
        <pre className="code">{file.data.text}</pre>
      )}
    </div>
  );
}

export function ContentPanel({ sourceId, itemId }: { sourceId: string; itemId: string }) {
  const detail = useItemDetail(sourceId, itemId);
  const [open, setOpen] = useState<string | null>(null);
  if (detail.isPending) return <Working>Loading content…</Working>;
  if (detail.isError) return <ErrorNotice error={detail.error} />;
  const { item, body } = detail.data;
  const isInstructions = item.kind === "instructions";
  const paths = item.files.map((f) => f.path);
  return (
    <div className="content-panel">
      {item.diagnostics.length > 0 ? (
        <details className="diagnostics">
          <summary>
            {item.diagnostics.length} note{item.diagnostics.length === 1 ? "" : "s"} from reading this item
          </summary>
          <ul>
            {item.diagnostics.map((d, i) => (
              <li key={i}>
                <strong>{levelLabel(d.level)}</strong>{" "}
                {d.path ? <span className="mono">{d.path}: </span> : null}
                {d.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="content-files">
        <h4 className="explain-heading">Files</h4>
        <ul className="file-list">
          {item.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={`file-row${open === f.path ? " is-active" : ""}`}
                aria-expanded={open === f.path}
                onClick={() => setOpen(open === f.path ? null : f.path)}
              >
                <Icon name="file" size={14} />
                <span className="mono">{f.path}</span>
                <span className="muted">{f.size} B</span>
              </button>
              {open === f.path ? (
                <FileViewer
                  sourceId={sourceId}
                  itemId={itemId}
                  path={f.path}
                  files={paths}
                  onLocalLink={setOpen}
                />
              ) : null}
            </li>
          ))}
        </ul>
        <p className="muted">License: {licenseText(item.license, item.licenseFile)}</p>
        {item.licenseRestricted ? (
          <Notice tone="warn" title="Declared proprietary">
            Check its terms before copying it into a repository others can see or sharing it with a team
            library.
          </Notice>
        ) : null}
      </div>
      <div className="content-body">
        <h4 className="explain-heading">{isInstructions ? "Instructions" : "SKILL.md"}</h4>
        <Markdown text={body} files={paths} onLocalLink={(p) => setOpen(p)} />
      </div>
    </div>
  );
}
