/** Recognized material relationships are read from portable instructions, never a registry. */
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { type MaterialKind, materialKind } from "../../../../lib/materials";

export type MaterialUse = {
  path: string;
  from: number;
  to: number;
  label: string;
  /** The nearest instruction, rather than a filesystem-derived description. */
  context: string;
  kind: "link" | "code" | "image";
  materialKind: MaterialKind;
  missing: boolean;
  /** Original href, image source, or code text; used to reject stale edits. */
  source: string;
  linkTitle?: string | null;
};

/** A literal package path. Dot-prefix is harmless; traversal, schemes and absolute paths are not. */
export function safePackagePath(text: string): string | null {
  const path = text.replace(/^\.\//, "");
  if (
    !path ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

/** URI delimiters are removed before decoding, so %23 remains part of a filename. */
export function packagePathFromUri(uri: string): string | null {
  if (!uri || uri.startsWith("#") || uri.startsWith("?")) return null;
  const path = uri.split(/[?#]/, 1)[0] ?? "";
  try {
    return safePackagePath(decodeURIComponent(path));
  } catch {
    return null;
  }
}

export function packageUri(path: string): string | null {
  const safe = safePackagePath(path);
  return safe === null
    ? null
    : safe
        .split("/")
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join("/");
}

const fileLike = (path: string) => /\.[^./\s]{1,16}$/.test(path);

export function listMaterialUses(doc: PMNode, paths: readonly string[]): MaterialUse[] {
  const known = new Set(paths);
  const uses: MaterialUse[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "code_block" || node.type.name === "opaque_block") return false;
    const link = node.marks.find((mark) => mark.type.name === "link");
    const image = node.type.name === "image";
    const entity = node.type.name === "inline_raw" && node.attrs.kind === "entity" && !!link;
    if (node.type.name === "inline_raw" && !entity) return false;
    const code = node.isText && node.marks.some((mark) => mark.type.name === "code");
    if (!image && !entity && !node.isText) return true;
    const kind = image ? "image" : link ? "link" : code ? "code" : null;
    if (!kind) return false;
    const source = image ? String(node.attrs.src) : link ? String(link.attrs.href) : (node.text ?? "");
    const path = kind === "code" ? safePackagePath(source) : packagePathFromUri(source);
    if (!path) return false;
    if (
      !known.has(path) &&
      kind === "code" &&
      (!path.includes("/") || (!fileLike(path) && !/^(scripts|bin)\//.test(path)))
    )
      return false;
    const label = image
      ? String(node.attrs.alt || path.slice(path.lastIndexOf("/") + 1))
      : entity
        ? String(node.attrs.display ?? node.attrs.raw)
        : (node.text ?? "");
    const linkTitle = link ? (link.attrs.title as string | null) : null;
    const parent = doc.resolve(pos).parent;
    const context = parent
      .textBetween(0, parent.content.size, " ", (child) =>
        child.type.name === "image"
          ? String(child.attrs.alt || child.attrs.src)
          : child.type.name === "inline_raw" && child.attrs.kind === "entity"
            ? String(child.attrs.display ?? child.attrs.raw)
            : child.textContent,
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    const previous = uses[uses.length - 1];
    // Emphasis can split a link's text into nodes; it still represents one relationship.
    if (
      previous &&
      kind === "link" &&
      previous.kind === kind &&
      previous.source === source &&
      previous.linkTitle === linkTitle &&
      previous.to === pos
    ) {
      previous.to = pos + node.nodeSize;
      previous.label += label;
    } else {
      uses.push({
        path,
        from: pos,
        to: pos + node.nodeSize,
        label,
        context,
        kind,
        materialKind: materialKind(path),
        missing: !known.has(path),
        source,
        linkTitle,
      });
    }
    return false;
  });
  return uses;
}

function stillHere(view: EditorView, use: MaterialUse): boolean {
  if (!view.editable || use.from < 0 || use.to > view.state.doc.content.size) return false;
  return listMaterialUses(view.state.doc, [use.path]).some(
    (current) =>
      current.from === use.from &&
      current.to === use.to &&
      current.source === use.source &&
      current.kind === use.kind,
  );
}

/** Detach only this relationship, retaining readable words. The package file is untouched. */
export function detachMaterialUse(view: EditorView, use: MaterialUse): boolean {
  if (!stillHere(view, use)) return false;
  const tr = closeHistory(view.state.tr);
  if (use.kind === "image") tr.replaceWith(use.from, use.to, view.state.schema.text(use.label));
  else {
    tr.removeMark(use.from, use.to, view.state.schema.marks[use.kind === "link" ? "link" : "code"]);
    // A code-styled link label would otherwise still be a recognized path after detaching.
    if (use.kind === "link") tr.removeMark(use.from, use.to, view.state.schema.marks.code);
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Retarget one recognized use. Link wording and surrounding instructions stay the author's. */
export function replaceMaterialUse(view: EditorView, use: MaterialUse, newPath: string): boolean {
  const path = safePackagePath(newPath);
  const uri = packageUri(newPath);
  if (!path || !uri || !stillHere(view, use)) return false;
  const tr = closeHistory(view.state.tr);
  const current = view.state.doc.nodeAt(use.from);
  if (!current) return false;
  if (use.kind === "code") tr.replaceWith(use.from, use.to, view.state.schema.text(path, current.marks));
  else {
    const suffix = use.source.match(/[?#].*$/)?.[0] ?? "";
    if (use.kind === "image") tr.setNodeMarkup(use.from, undefined, { ...current.attrs, src: uri + suffix });
    else {
      const old = current.marks.find((mark) => mark.type.name === "link");
      if (!old) return false;
      tr.removeMark(use.from, use.to, old.type);
      tr.addMark(use.from, use.to, old.type.create({ ...old.attrs, href: uri + suffix }));
    }
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
