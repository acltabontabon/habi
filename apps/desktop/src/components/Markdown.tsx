/**
 * Renders skill Markdown safely: raw HTML is skipped and the output is
 * sanitized; links open in the system browser (https only) after a click.
 * Links that Habi will not follow say so instead of silently doing nothing.
 */
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useOpenExternal } from "../lib/safeInvoke";
import { highlight } from "./highlight";

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

export function Markdown({
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
  return (
    <div className="prose">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => {
            const url = href ?? "";
            if (url.startsWith("https://")) {
              return (
                <a
                  href={url}
                  title={`Opens ${url} in your browser`}
                  onClick={(event) => {
                    event.preventDefault();
                    openExternal(url);
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
            const local = isRelative(url) ? localLinkPath(base ? `${base}/${url}` : url) : null;
            if (local && onLocalLink && (!files || files.includes(local))) {
              return (
                <button
                  type="button"
                  className="link-btn"
                  title={`Show ${local}`}
                  onClick={() => onLocalLink(local)}
                >
                  {children}
                </button>
              );
            }
            if (local) {
              return (
                <Inert
                  note={
                    files && !files.includes(local)
                      ? `${local} is not among this skill's files`
                      : `file in this skill: ${local}`
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
            const text = String(children ?? "");
            const spans = lang ? highlight(text.replace(/\n$/, ""), lang) : null;
            return <code className={className}>{spans ?? children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
