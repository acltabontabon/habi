/**
 * Files named in the words. A reference to something in the package reads as the
 * object it is; a path that looks meant for the package but isn't there can be
 * made or chosen. These are decorations: the Markdown stays exactly what the
 * author wrote. A click opens a peek, and nothing is run or fetched.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

export const FILE_ATTR = "data-file-ref";

/** Looks like a path inside a skill: a folder and a file with an extension. */
const PATHLIKE = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\/[\w.-]+\.[A-Za-z0-9]{1,8}$/;

export function normalPath(text: string): string {
  return text.replace(/^\.\//, "");
}

export function looksLikePackagePath(text: string): boolean {
  return PATHLIKE.test(text) && !text.includes("..") && !/^[a-z][a-z0-9+.-]*:/i.test(text);
}

const refreshKey = new PluginKey("doc-file-refs");

function decorate(doc: PMNode, paths: readonly string[]): DecorationSet {
  const known = new Set(paths);
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return node.type.name !== "code_block";
    const text = node.text ?? "";
    const link = node.marks.find((m) => m.type.name === "link");
    const code = node.marks.some((m) => m.type.name === "code");
    const target = link ? normalPath(link.attrs.href as string) : code ? normalPath(text) : null;
    if (!target) return false;
    const inside = known.has(target);
    if (!inside && !(code && looksLikePackagePath(text))) return false;
    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: `doc-file${inside ? "" : " is-absent"}`,
        [FILE_ATTR]: target,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function fileRefsPlugin(paths: () => readonly string[]): Plugin {
  return new Plugin({
    key: refreshKey,
    state: {
      init: (_c, state) => decorate(state.doc, paths()),
      apply: (tr, old) => (tr.docChanged || tr.getMeta(refreshKey) ? decorate(tr.doc, paths()) : old),
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
  const name = path.slice(path.lastIndexOf("/") + 1);
  const target = /\s/.test(path) ? `<${path}>` : path;
  return IMAGE.test(path) ? `![${name}](${target})` : `[${name}](${target})`;
}
