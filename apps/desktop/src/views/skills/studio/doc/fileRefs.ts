/**
 * Files named in the words. A reference to something in the package reads as the
 * object it is; a path that looks meant for the package but isn't there can be
 * made or chosen. These are decorations: the Markdown stays exactly what the
 * author wrote. A click opens a peek, and nothing is run or fetched.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

import { listMaterialUses, packagePathFromUri, packageUri, safePackagePath } from "./materialUses";

export const FILE_ATTR = "data-file-ref";

/** Kept for callers displaying a relative URI as a package path. */
export function normalPath(text: string): string {
  return packagePathFromUri(text) ?? text;
}

export function looksLikePackagePath(text: string): boolean {
  const path = safePackagePath(text);
  return !!path?.includes("/") && /\.[^./\s]{1,16}$/.test(path);
}

const refreshKey = new PluginKey("doc-file-refs");

function decorate(doc: PMNode, paths: readonly string[], caret: { from: number; to: number }): DecorationSet {
  const decos: Decoration[] = [];
  for (const use of listMaterialUses(doc, paths)) {
    const attrs = {
      class: `doc-file${use.missing ? " is-absent" : ""}`,
      [FILE_ATTR]: use.path,
      "data-kind": use.materialKind,
      "data-material-from": String(use.from),
      spellcheck: "false",
      // Tooltips adopts `title` by mutating attributes; keep this PM-owned DOM stable.
      "data-tip": `${use.materialKind}: ${use.path}${use.missing ? " · not in this skill" : ""} · Click or press Cmd/Ctrl+Enter to inspect`,
      "aria-description": `${use.materialKind}: ${use.path}${use.missing ? " · not in this skill" : ""}. Click or press Cmd/Ctrl+Enter to inspect.`,
    };
    if (use.kind === "image") {
      decos.push(Decoration.node(use.from, use.to, attrs));
      continue;
    }
    // The folder comes back while the caret is in a code path, to edit it directly.
    const slash = use.kind === "code" ? use.source.lastIndexOf("/") : -1;
    if (slash >= 0 && (caret.to < use.from || caret.from > use.to)) {
      decos.push(
        Decoration.inline(use.from, use.from + slash + 1, {
          class: "doc-file-dir",
          [FILE_ATTR]: use.path,
          "data-material-from": String(use.from),
        }),
        Decoration.inline(use.from + slash + 1, use.to, attrs),
      );
    } else decos.push(Decoration.inline(use.from, use.to, attrs));
  }
  return DecorationSet.create(doc, decos);
}

export function fileRefsPlugin(paths: () => readonly string[]): Plugin {
  return new Plugin({
    key: refreshKey,
    state: {
      init: (_c, state) => decorate(state.doc, paths(), state.selection),
      apply: (tr, old, _before, state) =>
        tr.docChanged || tr.selectionSet || tr.getMeta(refreshKey)
          ? decorate(tr.doc, paths(), state.selection)
          : old,
    },
    props: {
      decorations(state) {
        return refreshKey.getState(state) as DecorationSet;
      },
    },
  });
}

/** The package's files changed: what's known and what's absent may have too. */
export function refreshFileRefs(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(refreshKey, true).setMeta("addToHistory", false));
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** How a file is written into the instructions: a picture shows, anything else is a link. */
export function markdownForFile(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[\\[\]`*_~<>&!]/g, "\\$&");
  const target = packageUri(path);
  if (target === null) return "";
  return IMAGE.test(path) ? `![${name}](${target})` : `[${name}](${target})`;
}
