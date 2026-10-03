/**
 * Renders skill Markdown safely: raw HTML is skipped and the output is
 * sanitized; links open in the system browser (https only) after a click.
 * Links that Habi will not follow say so instead of silently doing nothing.
 */
import { memo, type ReactNode, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useOpenExternal } from "../lib/safeInvoke";
import { highlight } from "./highlight";

const PLUGINS = [remarkGfm];
const REHYPE = [rehypeSanitize];

function isRelative(url: string): boolean {
  return Boolean(url) && !url.startsWith("#") && !url.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** "./references/x.md#part" -> "references/x.md"; null when not a relative file link. */
export function localLinkPath(url: string): string | null {
  if (!isRelative(url)) return null;
  let path = url.split("#")[0]?.split("?")[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw text if it is not valid percent-encoding.
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function Inert({ children, note, title }: { children: ReactNode; note: string; title: string }) {
  return (
    <span className="link-inert" title={title}>
      <span className="link-inert-text">{children}</span> <span className="muted">({note})</span>
    </span>
  );
}

/**
 * Memoized, and the rendered tree is kept until the text, its folder or the skill's files change:
 * parsing and highlighting a long skill is the costly part, and the screens around it re-render
 * often (scrolling, autosave, hover). The callbacks are read when a link is used, so new function
 * props never re-render the tree.
 */
export const Markdown = memo(function Markdown({
  text,
  onLocalLink,
  files,
  base,
}: {
  text: string;
  /** Folder (skill-relative) of the file being shown, for its relative links. */
  base?: string;
  /** Opens a file of the same skill; receives a normalized, skill-relative path. */
  onLocalLink?: (path: string) => void;
  /** The skill's files, to tell a working local link from a broken one. */
  files?: string[];
}) {
  const openExternal = useOpenExternal();
  const external = useRef(openExternal);
  external.current = openExternal;
  const local = useRef(onLocalLink);
  local.current = onLocalLink;
  const opensLocal = Boolean(onLocalLink);
  // By content: callers often pass a fresh array of the same paths.
  const fileList = files?.join("\0");

  return useMemo(() => {
    const known = fileList === undefined ? undefined : fileList.split("\0");
    const components: Components = {
      a: ({ href, children }) => {
        const url = href ?? "";
        if (url.startsWith("https://")) {
          return (
            <a
              href={url}
              title={`Opens ${url} in your browser`}
              onClick={(event) => {
                event.preventDefault();
                external.current(url);
              }}
            >
              {children}
            </a>
          );
        }
        if (url.startsWith("#")) return <span>{children}</span>;
        if (url.startsWith("http://")) {
          return (
            <Inert note="not opened: Habi opens only https links" title={url}>
              {children}
            </Inert>
          );
        }
        const path = isRelative(url) ? localLinkPath(base ? `${base}/${url}` : url) : null;
        if (path && opensLocal && (!known || known.includes(path))) {
          return (
            <button
              type="button"
              className="link-btn"
              title={`Show ${path}`}
              onClick={() => local.current?.(path)}
            >
              {children}
            </button>
          );
        }
        if (path) {
          return (
            <Inert
              note={
                known && !known.includes(path)
                  ? `${path} is not among this skill's files`
                  : `file in this skill: ${path}`
              }
              title={url}
            >
              {children}
            </Inert>
          );
        }
        return (
          <Inert note="link not opened" title={url}>
            {children}
          </Inert>
        );
      },
      img: ({ alt }) => <span className="muted">[image: {alt ?? "no description"}]</span>,
      code: ({ className, children }) => {
        // Fenced code names its language; inline code does not.
        const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
        const code = String(children ?? "");
        const spans = lang ? highlight(code.replace(/\n$/, ""), lang) : null;
        return <code className={className}>{spans ?? children}</code>;
      },
    };
    return (
      <div className="prose">
        <ReactMarkdown skipHtml remarkPlugins={PLUGINS} rehypePlugins={REHYPE} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    );
  }, [text, base, fileList, opensLocal]);
});
