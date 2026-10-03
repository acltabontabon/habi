/**
 * Highlights fenced code in rendered Markdown with the parsers the editor
 * already ships, as plain spans (no HTML is parsed or injected). Unknown
 * languages stay plain text.
 */
import { javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { jsonLanguage } from "@codemirror/lang-json";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { pythonLanguage } from "@codemirror/lang-python";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { ReactNode } from "react";

const shellLanguage = StreamLanguage.define(shell);

/** Anything that turns source into the tree `highlightCode` walks. */
type Parser = { parse: (input: string) => Parameters<typeof highlightCode>[1] };

function parserFor(lang: string): Parser | null {
  switch (lang.toLowerCase()) {
    case "js":
    case "javascript":
    case "mjs":
    case "jsx":
      return javascriptLanguage.parser;
    case "ts":
    case "typescript":
    case "tsx":
      return typescriptLanguage.parser;
    case "json":
      return jsonLanguage.parser;
    case "py":
    case "python":
      return pythonLanguage.parser;
    case "yaml":
    case "yml":
      return yamlLanguage.parser;
    case "md":
    case "markdown":
      return markdownLanguage.parser;
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
    case "console":
      return shellLanguage.parser;
    default:
      return null;
  }
}

/** Highlighted spans for `code` in `lang`, or null when the language is not known. */
export function highlight(code: string, lang: string): ReactNode[] | null {
  const parser = parserFor(lang);
  if (!parser || code.length > 200_000) return null;
  const out: ReactNode[] = [];
  let key = 0;
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, classes) => {
      out.push(
        classes ? (
          <span key={key++} className={classes}>
            {text}
          </span>
        ) : (
          text
        ),
      );
    },
    () => {
      out.push("\n");
    },
  );
  return out;
}
