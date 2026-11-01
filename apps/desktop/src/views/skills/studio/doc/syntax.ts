/** Colour in code blocks, as decorations: the block stays ordinary editable text. */
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import type { Parser } from "@lezer/common";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { parser as javascript } from "@lezer/javascript";
import { parser as json } from "@lezer/json";
import { parser as python } from "@lezer/python";
import { parser as yaml } from "@lezer/yaml";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const shellParser = StreamLanguage.define(shell).parser;
const tsx = javascript.configure({ dialect: "ts jsx" });

function parserFor(info: string): Parser | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (lang) {
    case "js":
    case "javascript":
    case "jsx":
    case "ts":
    case "typescript":
    case "tsx":
      return tsx;
    case "json":
      return json;
    case "py":
    case "python":
      return python;
    case "yml":
    case "yaml":
      return yaml;
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
    case "console":
      return shellParser;
    default:
      return null;
  }
}

type Spot = { from: number; to: number; cls: string };
const cache = new WeakMap<PMNode, Spot[]>();

function spotsOf(node: PMNode): Spot[] {
  const known = cache.get(node);
  if (known) return known;
  const parser = parserFor(node.attrs.info as string);
  const text = node.textContent;
  const spots: Spot[] = [];
  if (parser && text.length < 64_000) {
    highlightTree(parser.parse(text), classHighlighter, (from, to, cls) => {
      spots.push({ from, to, cls });
    });
  }
  cache.set(node, spots);
  return spots;
}

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    for (const s of spotsOf(node)) {
      decorations.push(Decoration.inline(pos + 1 + s.from, pos + 1 + s.to, { class: s.cls }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function syntaxPlugin(): Plugin {
  const key = new PluginKey<DecorationSet>("doc-syntax");
  return new Plugin({
    key,
    state: {
      init: (_c, state) => decorate(state.doc),
      apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
