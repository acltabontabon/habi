import { history, undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";
import { type DecorationSet, EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vitest";
import { fileRefsPlugin, markdownForFile } from "./fileRefs";
import { parseBody } from "./markdown/parse";
import { write } from "./markdown/reconcile";
import { detachMaterialUse, listMaterialUses, packagePathFromUri, replaceMaterialUse } from "./materialUses";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
const paths = Object.freeze(["scripts/check files.sh", "references/policy#1.md", "assets/flow chart.png"]);
function editor(source: string) {
  const parsed = parseBody(source);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc: parsed.doc, plugins: [history()] }),
  });
  views.push(view);
  return { view, text: () => write(view.state.doc, parsed.baseline).text };
}
const all = (source: string, known = paths) => listMaterialUses(parseBody(source).doc, known);

describe("recognized material relationships", () => {
  it("finds repeated references and the instruction each belongs to", () => {
    const uses = all(
      "Inspect with [changed files](scripts/check%20files.sh).\n\nVerify using `scripts/check files.sh`.\n",
    );
    expect(uses.map((use) => [use.path, use.kind, use.missing])).toEqual([
      ["scripts/check files.sh", "link", false],
      ["scripts/check files.sh", "code", false],
    ]);
    expect(uses[0]?.context).toBe("Inspect with changed files.");
    expect(uses[1]?.context).toBe("Verify using scripts/check files.sh.");
    expect(uses[0]?.materialKind).toBe("script");
    expect(uses[0]?.from).not.toBe(uses[1]?.from);
  });

  it("finds missing links and images, excluding prose, fences, raw HTML and remote URLs", () => {
    const uses = all(
      "Use [policy](references/missing.md).\n\n![map](assets/missing.png)\n\nreferences/prose.md\n\n```sh\necho references/code.md\n```\n\n<div>references/raw.md</div>\n\n[web](https://example.com/a.md) [outside](../a.md)\n",
    );
    expect(uses.map((use) => [use.path, use.kind, use.missing])).toEqual([
      ["references/missing.md", "link", true],
      ["assets/missing.png", "image", true],
    ]);
  });

  it("recognizes extensionless local links and conventional script paths", () => {
    const uses = all("Run [tool](custom/tool) or `scripts/check`. Read [license](LICENSE).\n");
    expect(uses.map((use) => use.path)).toEqual(["custom/tool", "scripts/check", "LICENSE"]);
    expect(uses.every((use) => use.missing)).toBe(true);
  });

  it("treats emphasis within a link as one relationship", () => {
    const uses = all("Read [the **review** policy](references/policy%231.md).\n");
    expect(uses).toHaveLength(1);
    expect(uses[0]?.label).toBe("the review policy");
  });

  it("keeps a link with an entity label as one reference", () => {
    const source = "Read [policy &amp; examples](references/policy%231.md).\n";
    const { view, text } = editor(source);
    const uses = listMaterialUses(view.state.doc, paths);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.label).toBe("policy & examples");
    expect(uses[0]?.context).toBe("Read policy & examples.");
    const use = uses[0];
    if (!use) throw new Error("No reference");
    expect(replaceMaterialUse(view, use, "references/new.md")).toBe(true);
    expect(text()).toBe(source.replace("policy%231.md", "new.md"));
    undo(view.state, view.dispatch);
    expect(text()).toBe(source);
  });

  it("distinguishes URI fragments from encoded filename characters and decodes once", () => {
    expect(packagePathFromUri("./references/policy%231.md#checks")).toBe("references/policy#1.md");
    expect(packagePathFromUri("references/file%2520name.md")).toBe("references/file%20name.md");
    for (const value of [
      "../secret.md",
      "%2E%2E/secret.md",
      "/secret.md",
      "file:///x.md",
      "https%3A//example.com/a.md",
      "references/%00.md",
      "#heading",
      "%broken.md",
    ])
      expect(packagePathFromUri(value)).toBeNull();
  });

  it("round-trips spaces, hashes, brackets and parentheses in portable inserted links", () => {
    for (const path of [
      "scripts/check files.sh",
      "references/policy#1.md",
      "references/a [b](c).md",
      "assets/flow chart.png",
      "references/100%.md",
      "references/a&copy;<tag>~~.md",
    ]) {
      const markdown = markdownForFile(path);
      const uses = listMaterialUses(parseBody(markdown).doc, [path]);
      expect(uses, markdown).toHaveLength(1);
      expect(uses[0]?.path).toBe(path);
      expect(uses[0]?.missing).toBe(false);
    }
    expect(markdownForFile("../outside.md")).toBe("");
  });

  it("decorates missing relative links without changing their source", () => {
    const source = "Read [policy](references/missing%20policy.md).\n";
    const parsed = parseBody(source);
    const plugin = fileRefsPlugin(() => []);
    const state = EditorState.create({ doc: parsed.doc, plugins: [plugin] });
    const decorations = (plugin.props.decorations as (state: EditorState) => DecorationSet).call(
      plugin,
      state,
    );
    expect(decorations.find()).toHaveLength(1);
    const decoration = decorations.find()[0] as unknown as { type: { attrs: Record<string, string> } };
    expect(decoration.type.attrs["data-file-ref"]).toBe("references/missing policy.md");
    expect(decoration.type.attrs.class).toContain("is-absent");
    expect(write(state.doc, parsed.baseline).text).toBe(source);
  });

  it("detaches one use while keeping its words, other uses, and exact undo", () => {
    const source =
      "Use [changed files](scripts/check%20files.sh).\n\n\nThen `scripts/check files.sh`.\n\n<!-- keep -->\n";
    const { view, text } = editor(source);
    const use = listMaterialUses(view.state.doc, paths)[0];
    if (!use) throw new Error("No reference");
    expect(detachMaterialUse(view, use)).toBe(true);
    expect(text()).toBe("Use changed files.\n\n\nThen `scripts/check files.sh`.\n\n<!-- keep -->\n");
    expect(listMaterialUses(view.state.doc, paths)).toHaveLength(1);
    undo(view.state, view.dispatch);
    expect(text()).toBe(source);
    expect(paths).toEqual(["scripts/check files.sh", "references/policy#1.md", "assets/flow chart.png"]);
  });

  it("detaches code and images to readable text without leaving recognized relationships", () => {
    for (const source of ["Use `scripts/check files.sh`.\n", "Study ![flow](assets/flow%20chart.png).\n"]) {
      const { view, text } = editor(source);
      const use = listMaterialUses(view.state.doc, paths)[0];
      if (!use) throw new Error("No reference");
      expect(detachMaterialUse(view, use)).toBe(true);
      expect(listMaterialUses(view.state.doc, paths)).toHaveLength(0);
      expect(text()).toContain(use.label);
      undo(view.state, view.dispatch);
      expect(text()).toBe(source);
    }
  });

  it("retargets exactly one link, preserving label, emphasis, anchor and unrelated bytes", () => {
    const source =
      "Read [the **policy**](references/policy%231.md#checks).\n\n\n* odd   spacing\n\nRead [policy](references/policy%231.md).\n";
    const { view, text } = editor(source);
    const use = listMaterialUses(view.state.doc, paths)[0];
    if (!use) throw new Error("No reference");
    expect(replaceMaterialUse(view, use, "references/new policy#2.md")).toBe(true);
    expect(text()).toBe(
      source.replace("references/policy%231.md#checks", "references/new%20policy%232.md#checks"),
    );
    undo(view.state, view.dispatch);
    expect(text()).toBe(source);
  });

  it("retargets literal code paths and images and rejects stale or unsafe updates", () => {
    for (const source of ["Use `scripts/check files.sh`.\n", "Study ![flow](assets/flow%20chart.png).\n"]) {
      const { view, text } = editor(source);
      const use = listMaterialUses(view.state.doc, paths)[0];
      if (!use) throw new Error("No reference");
      expect(replaceMaterialUse(view, use, "../outside.md")).toBe(false);
      expect(text()).toBe(source);
      expect(replaceMaterialUse(view, use, "assets/new #file.png")).toBe(true);
      expect(listMaterialUses(view.state.doc, ["assets/new #file.png"])[0]?.missing).toBe(false);
      expect(detachMaterialUse(view, use)).toBe(false);
      undo(view.state, view.dispatch);
      expect(text()).toBe(source);
    }
  });
});
