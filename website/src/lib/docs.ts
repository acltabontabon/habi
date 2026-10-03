/**
 * The documentation, as pages on the site.
 *
 *   docs/README.md                    ->  /habi/docs/
 *   docs/guide/<name>.md              ->  /habi/docs/<name>/
 *   docs/library-authors/<name>.md    ->  /habi/docs/<name>/
 *   docs/project/<name>.md            ->  /habi/docs/<name>/
 *
 * docs/ stays the one copy anybody edits. It reads on GitHub, where scripts/check-links.mjs
 * checks it; this only renders it, at build time, into pages that share the site's look.
 * docs/dev/ explains the code to the people changing it, so a link there, to the README or to a
 * source file goes to GitHub, where the code is.
 *
 * Every link is checked while it is rewritten. A page, a `#section` or an image the site does not
 * have fails the build, because on a static site a broken link fails silently, and only for a
 * reader.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { Marked, Renderer, type Tokens } from "marked";

/** The repository's docs/ folder, absolute; set in astro.config.mjs, which knows where it is. */
declare const __HABI_DOCS_DIR__: string;

export const REPOSITORY = "https://github.com/acltabontabon/habi";
const BLOB = `${REPOSITORY}/blob/main/`;
const TREE = `${REPOSITORY}/tree/main/`;

/** The index, then the folders whose pages are published. Everything else in docs/ stays on GitHub. */
const INDEX = "README.md";
const PUBLISHED = ["guide", "library-authors", "project"];

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export type Heading = { id: string; depth: number; text: string };

export type DocPage = {
  /** The file inside docs/: "guide/getting-started.md". */
  source: string;
  /** "" for the index, otherwise the file's name: "getting-started". */
  slug: string;
  title: string;
  description: string;
  html: string;
  headings: Heading[];
};

/** A page as the index lists it: its name there, and the line that says what it is for. */
export type DocLink = { slug: string; title: string; summary: string };
export type DocGroup = { heading: string; items: DocLink[] };

export type Docs = {
  pages: DocPage[];
  groups: DocGroup[];
  /** Images the pages use, by their path inside docs/media/, with where each is on disk. */
  media: Map<string, string>;
};

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** Plain text of inline Markdown, for titles, descriptions and the contents. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * GitHub's heading-to-anchor rule, the same one scripts/check-links.mjs checks the docs against,
 * so a `#section` link that works on GitHub lands on the same section here.
 */
function slugOf(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Markdown with fenced code blocks blanked out, so a `# comment` in a shell block is not a heading. */
function prose(markdown: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return markdown
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[`~]*[ \t]*$/gm, blank);
}

function headingsOf(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const [, hashes = "", heading = ""] of prose(markdown).matchAll(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = slugOf(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    headings.push({ id: n === 0 ? base : `${base}-${n}`, depth: hashes.length, text: plain(heading) });
  }
  return headings;
}

/** Every id a link may name on a page: its headings, and any explicit `<a id>`. */
function anchorsOf(markdown: string, headings: Heading[]): Set<string> {
  const ids = new Set(headings.map((h) => h.id));
  for (const [, id = ""] of markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) ids.add(id);
  return ids;
}

/** The first paragraph, as plain text, for the page's description. */
function descriptionOf(markdown: string, fallback: string): string {
  const lead = prose(markdown)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|\||<|>|-|\*|\d+\.|```|~~~|!\[)/.test(block));
  if (!lead) return fallback;
  const text = plain(lead);
  if (text.length <= 180) return text;
  const cut = text.slice(0, 180);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** A PNG's or JPEG's size from its header, so a screenshot keeps its space before it arrives. */
function imageSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file);
  if (bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1] ?? 0;
      const length = bytes.readUInt16BE(at + 2);
      // Start of frame (baseline or progressive): height, then width.
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

type Source = { source: string; slug: string; markdown: string; headings: Heading[]; anchors: Set<string> };

function collect(docsDir: string): Map<string, Source> {
  const files = [INDEX];
  for (const folder of PUBLISHED) {
    const dir = join(docsDir, folder);
    if (!existsSync(dir)) continue;
    files.push(
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `${folder}/${f}`),
    );
  }
  const sources = new Map<string, Source>();
  const slugs = new Map<string, string>();
  for (const source of files) {
    const slug = source === INDEX ? "" : posix.basename(source, ".md");
    const taken = slugs.get(slug);
    if (taken !== undefined) throw new Error(`docs: ${source} and ${taken} would both be /docs/${slug}/`);
    slugs.set(slug, source);
    const markdown = readFileSync(join(docsDir, source), "utf8");
    const headings = headingsOf(markdown);
    sources.set(source, { source, slug, markdown, headings, anchors: anchorsOf(markdown, headings) });
  }
  return sources;
}

/**
 * The sidebar: the pages the index lists in its tables, under the index's own section headings,
 * in its order and with its names for them. A section with no published page (Working on Habi)
 * is left out, and a page the index does not list is still a page, just not in the sidebar.
 */
function groupsOf(sources: Map<string, Source>): DocGroup[] {
  const index = sources.get(INDEX);
  if (!index) return [];
  const groups: DocGroup[] = [];
  const listed = new Set<string>();
  let current: DocGroup | null = null;
  for (const line of prose(index.markdown).split("\n")) {
    const heading = line.match(/^##[ \t]+(.+?)[ \t#]*$/);
    if (heading) {
      current = { heading: plain(heading[1] ?? ""), items: [] };
      groups.push(current);
      continue;
    }
    const row = line.match(/^\|\s*\[([^\]]+)\]\(([^)#\s]+)\)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row || !current) continue;
    const target = posix.normalize(row[2] ?? "");
    const page = sources.get(target);
    if (!page || listed.has(target)) continue;
    listed.add(target);
    current.items.push({ slug: page.slug, title: plain(row[1] ?? ""), summary: plain(row[3] ?? "") });
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Renders the docs for a site served at `base` ("/habi/"). Throws, naming every one, when a
 * published page links to something that is not there.
 */
export function renderDocs(base: string, docsDir: string = __HABI_DOCS_DIR__): Docs {
  const root = base.replace(/\/?$/, "/");
  const repoDir = join(docsDir, "..");
  const sources = collect(docsDir);
  const groups = groupsOf(sources);
  const media = new Map<string, string>();
  const broken: string[] = [];
  const pageUrl = (slug: string) => `${root}docs/${slug ? `${slug}/` : ""}`;

  const pages = [...sources.values()].map((page): DocPage => {
    const resolve = (href: string): { href: string; external: boolean; file?: string } => {
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { href, external: true };
      const [rawPath = "", anchor] = href.split("#", 2);
      const hash = anchor ? `#${anchor}` : "";
      if (!rawPath) {
        if (anchor && !page.anchors.has(anchor)) broken.push(`${page.source} → #${anchor}`);
        return { href, external: false };
      }
      const path = decodeURIComponent(rawPath);
      const inRepo = posix.normalize(posix.join("docs", posix.dirname(page.source), path));
      const inDocs = inRepo.startsWith("docs/") ? inRepo.slice("docs/".length) : null;
      const published = inDocs ? sources.get(inDocs) : undefined;
      if (published) {
        if (anchor && !published.anchors.has(anchor)) broken.push(`${page.source} → ${href}`);
        return { href: pageUrl(published.slug) + hash, external: false };
      }
      const onDisk = join(repoDir, inRepo);
      if (inRepo.startsWith("..") || !existsSync(onDisk)) {
        broken.push(`${page.source} → ${href} (no such file)`);
        return { href, external: false };
      }
      if (inDocs && IMAGE_TYPES[extname(inDocs).toLowerCase()]) {
        // Pictures live in docs/media/, and are served from the same place under /docs/.
        if (!inDocs.startsWith("media/")) {
          broken.push(`${page.source} → ${href} (images belong in docs/media/)`);
          return { href, external: false };
        }
        media.set(inDocs.slice("media/".length), onDisk);
        return { href: `${root}docs/${inDocs}`, external: false, file: onDisk };
      }
      // Anything else lives in the repository: a contributor's page, the README, a source file.
      const where = statSync(onDisk).isDirectory() ? TREE : BLOB;
      return { href: `${where}${inRepo}${hash}`, external: true };
    };

    const seen = new Map<string, number>();
    const marked = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth, text }: Tokens.Heading) {
          const base = slugOf(text);
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const id = n === 0 ? base : `${base}-${n}`;
          const inner = this.parser.parseInline(tokens);
          if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
          return `<h${depth} id="${id}">${inner}<a class="doc-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
        },
        link({ href, title, tokens }: Tokens.Link) {
          const target = resolve(href);
          const attrs = `${title ? ` title="${escape(title)}"` : ""}${target.external ? ' class="is-external"' : ""}`;
          return `<a href="${escape(target.href)}"${attrs}>${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, title, text }: Tokens.Image) {
          const target = resolve(href);
          const size = target.file ? imageSize(target.file) : null;
          const dims = size ? ` width="${size.width}" height="${size.height}"` : "";
          const attrs = title ? ` title="${escape(title)}"` : "";
          const img = `<img src="${escape(target.href)}" alt="${escape(text)}"${attrs}${dims} loading="lazy" decoding="async" />`;
          // A screenshot is narrower than the app it shows: it opens at full size.
          return target.file ? `<a class="doc-figure" href="${escape(target.href)}">${img}</a>` : img;
        },
        table(token: Tokens.Table) {
          return `<div class="doc-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
        },
      },
    });

    const title = page.headings.find((h) => h.depth === 1)?.text ?? "Habi documentation";
    return {
      source: page.source,
      slug: page.slug,
      title,
      description: descriptionOf(page.markdown, title),
      html: marked.parse(page.markdown, { async: false }),
      headings: page.headings,
    };
  });

  if (broken.length > 0) {
    throw new Error(`docs: ${broken.length} broken link(s) in the published docs:\n  ${broken.join("\n  ")}`);
  }
  return { pages, groups, media };
}

let built: Docs | null = null;

/**
 * The docs for this build. The production build renders them once; the dev server renders them
 * on every request, so an edited page shows on the next refresh.
 */
export function docs(): Docs {
  const base = import.meta.env.BASE_URL;
  if (import.meta.env.DEV) return renderDocs(base);
  built ??= renderDocs(base);
  return built;
}

export const mediaType = (path: string) => IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export const sourceUrl = (page: DocPage) => `${BLOB}docs/${page.source}`;
