/** The one place Markdown is read: CommonMark plus the GFM extensions, with source positions. */
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const extensions = [gfm()];
const mdastExtensions = [gfmFromMarkdown()];

export function parseMdast(markdown: string): Root {
  return fromMarkdown(markdown, { extensions, mdastExtensions });
}
