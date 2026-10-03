/**
 * Highlights fenced code in rendered Markdown, as plain spans (no HTML is
 * parsed or injected). Languages with a Lezer grammar use the bare parser;
 * shell, which has none, is read line by line with CodeMirror's legacy mode
 * (a small, self-contained file). Neither needs the editor itself, so the
 * reader does not carry it. Unknown languages stay plain text.
 */
import type { StringStream } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import { parser as pythonParser } from "@lezer/python";
import { parser as yamlParser } from "@lezer/yaml";
import type { ReactNode } from "react";

/** Anything that turns source into the tree `highlightCode` walks. */
type Parser = { parse: (input: string) => Parameters<typeof highlightCode>[1] };

const GRAMMARS: Record<string, () => Parser> = {
  javascript: () => jsParser,
  jsx: () => jsParser.configure({ dialect: "jsx" }),
  typescript: () => jsParser.configure({ dialect: "ts" }),
  tsx: () => jsParser.configure({ dialect: "jsx ts" }),
  json: () => jsonParser,
  python: () => pythonParser,
  yaml: () => yamlParser,
  markdown: () => markdownParser.configure(GFM),
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  json: "json",
  py: "python",
  python: "python",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sh: "shell",
  bash: "shell",
  shell: "shell",
  zsh: "shell",
  console: "shell",
};

/** Each grammar is configured once, when first needed. */
const configured = new Map<string, Parser>();

function parserFor(language: string): Parser | null {
  const make = GRAMMARS[language];
  if (!make) return null;
  let parser = configured.get(language);
  if (!parser) {
    parser = make();
    configured.set(language, parser);
  }
  return parser;
}

/** Highlighted spans for `code` in `lang`, or null when the language is not known. */
export function highlight(code: string, lang: string): ReactNode[] | null {
  const language = ALIASES[lang.toLowerCase()];
  if (!language || code.length > 200_000) return null;
  if (language === "shell") return highlightShell(code);
  const parser = parserFor(language);
  if (!parser) return null;
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

/* ---------- Shell: the legacy mode, without the editor ---------- */

/** The legacy styles, as the classes `classHighlighter` gives the same tags in the editor. */
const SHELL_CLASSES: Record<string, string> = {
  keyword: "tok-keyword",
  operator: "tok-operator",
  string: "tok-string",
  "string.special": "tok-string2",
  number: "tok-number",
  atom: "tok-atom",
  comment: "tok-comment",
  meta: "tok-meta",
  attribute: "tok-propertyName",
  def: "tok-variableName tok-definition",
  variable: "tok-variableName",
  builtin: "tok-variableName",
};

type Match = string | RegExp | ((ch: string) => boolean);

/** The part of CodeMirror's StringStream a legacy mode reads: one line, a position, a token start. */
class LineStream {
  pos = 0;
  start = 0;
  constructor(readonly string: string) {}
  eol() {
    return this.pos >= this.string.length;
  }
  sol() {
    return this.pos === 0;
  }
  peek() {
    return this.string.charAt(this.pos) || undefined;
  }
  next() {
    return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined;
  }
  eat(match: Match) {
    const ch = this.string.charAt(this.pos);
    const ok =
      typeof match === "string"
        ? ch === match
        : ch !== "" && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (!ok) return undefined;
    this.pos++;
    return ch;
  }
  eatWhile(match: Match) {
    let ate = false;
    while (this.eat(match) !== undefined) ate = true;
    return ate;
  }
  eatSpace() {
    const start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos++;
    return this.pos > start;
  }
  skipToEnd() {
    this.pos = this.string.length;
  }
  skipTo(ch: string) {
    const at = this.string.indexOf(ch, this.pos);
    if (at < 0) return undefined;
    this.pos = at;
    return true;
  }
  backUp(n: number) {
    this.pos -= n;
  }
  column() {
    return this.start;
  }
  indentation() {
    return /^\s*/.exec(this.string)?.[0].length ?? 0;
  }
  match(pattern: string | RegExp, consume = true, caseInsensitive = false) {
    if (typeof pattern === "string") {
      const cased = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
      if (cased(this.string.slice(this.pos, this.pos + pattern.length)) !== cased(pattern)) return null;
      if (consume) this.pos += pattern.length;
      return true;
    }
    const found = this.string.slice(this.pos).match(pattern);
    if (!found || (found.index ?? 0) > 0) return null;
    if (consume) this.pos += found[0].length;
    return found;
  }
  current() {
    return this.string.slice(this.start, this.pos);
  }
}

function highlightShell(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const state = shell.startState?.(2);
  let key = 0;
  code.split("\n").forEach((line, n) => {
    if (n > 0) out.push("\n");
    const stream = new LineStream(line);
    // Neighbouring tokens of one style are one span.
    let text = "";
    let classes = "";
    const put = () => {
      if (text)
        out.push(
          classes ? (
            <span key={key++} className={classes}>
              {text}
            </span>
          ) : (
            text
          ),
        );
      text = "";
    };
    while (!stream.eol()) {
      stream.start = stream.pos;
      let style: string | null = null;
      // A mode may return an empty token while it changes state; one that never moves is skipped past.
      for (let tries = 0; tries < 10 && stream.pos === stream.start; tries++) {
        style = shell.token(stream as unknown as StringStream, state);
      }
      if (stream.pos === stream.start) {
        stream.pos++;
        style = null;
      }
      const next = (style ?? "")
        .split(" ")
        .map((s) => SHELL_CLASSES[s])
        .filter(Boolean)
        .join(" ");
      if (next !== classes) {
        put();
        classes = next;
      }
      text += stream.current();
    }
    put();
  });
  return out;
}
