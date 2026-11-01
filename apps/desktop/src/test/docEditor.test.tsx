import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { clipboardTextParser, looksLikeCode } from "../views/skills/studio/doc/clipboard";
import { moveBlock, toggleTask } from "../views/skills/studio/doc/commands";
import { DocEditor, type DocEditorHandle } from "../views/skills/studio/doc/DocEditor";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";
import { schema } from "../views/skills/studio/doc/markdown/schema";
import { moveBlocks, moveItem, placeBlocks, sectionRange } from "../views/skills/studio/doc/moves";
import { countInvisibles, removeInvisibles } from "../views/skills/studio/doc/plugins";
import { nextPrompt, PROMPTS } from "../views/skills/studio/doc/prompts";

// jsdom lays nothing out; the page only needs these not to throw.
const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
Element.prototype.scrollIntoView = () => {};
document.elementFromPoint = () => null;

function mount(value: string, extra: Partial<Parameters<typeof DocEditor>[0]> = {}) {
  const handle = createRef<DocEditorHandle>();
  const onChange = vi.fn();
  const utils = render(
    <DocEditor
      handle={handle}
      value={value}
      label="Instructions"
      onChange={onChange}
      paths={() => ["SKILL.md", "references/style.md", "assets/map.png"]}
      context={{}}
      {...extra}
    />,
  );
  const view = () => {
    const v = handle.current?.view();
    if (!v) throw new Error("the page isn't open");
    return v;
  };
  return { handle, onChange, view, ...utils };
}

describe("the page is the document", () => {
  it("shows Markdown as what it means, with no syntax on screen", () => {
    const { container } = mount("## Steps\n\n1. **Read** it\n2. Write `code`\n\n> [!NOTE]\n> Careful\n");
    const page = container.querySelector("[data-skill-editor]");
    expect(page?.querySelector("h2")?.textContent).toBe("Steps");
    expect(page?.querySelector("ol strong")?.textContent).toBe("Read");
    expect(page?.querySelector("ol code")?.textContent).toBe("code");
    expect(page?.querySelector(".doc-callout")?.getAttribute("data-kind")).toBe("NOTE");
    expect(page?.textContent).not.toMatch(/\*\*|##|\[!NOTE\]/);
  });

  it("writes typing back into the Markdown and nothing else", () => {
    const source = "* star\n* star\n\nOdd   spacing here\n\n| a |\n| - |\n| 1 |\n";
    const { handle, view } = mount(source);
    act(() => view().dispatch(view().state.tr.insertText("Now ", 1 + 1 + 1)));
    expect(handle.current?.text()).toBe("* Now star\n* star\n\nOdd   spacing here\n\n| a |\n| - |\n| 1 |\n");
  });

  it("gives the text only when asked or after a pause, not on every keystroke", async () => {
    const { handle, onChange, view } = mount("One\n");
    act(() => view().dispatch(view().state.tr.insertText("x", 1)));
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      handle.current?.text();
    });
    expect(onChange).toHaveBeenCalledWith("xOne\n");
  });

  it("undo gives back the file as it was", async () => {
    const source = "Odd   spacing\n\n\n* star\n";
    const { handle, view } = mount(source);
    const { undo } = await import("prosemirror-history");
    act(() => view().dispatch(view().state.tr.insertText("x", 1)));
    act(() => {
      undo(view().state, view().dispatch);
    });
    expect(handle.current?.text()).toBe(source);
  });

  it("an autosave's echo doesn't reset the document or its history", async () => {
    const onChange = vi.fn();
    const handle = createRef<DocEditorHandle>();
    const ui = (value: string) => (
      <DocEditor handle={handle} value={value} label="I" onChange={onChange} paths={() => []} context={{}} />
    );
    const { rerender } = render(ui("One\n"));
    const v = handle.current?.view();
    if (!v) throw new Error("no page");
    const { undoDepth } = await import("prosemirror-history");
    act(() => v.dispatch(v.state.tr.insertText("x", 1)));
    act(() => {
      handle.current?.text();
    });
    const before = handle.current?.view()?.state;
    rerender(ui("xOne\n"));
    expect(handle.current?.view()?.state).toBe(before);
    expect(undoDepth(handle.current?.view()?.state as never)).toBe(1);
  });

  it("a value from outside replaces the page, as when another version is chosen", () => {
    const handle = createRef<DocEditorHandle>();
    const ui = (value: string) => (
      <DocEditor handle={handle} value={value} label="I" onChange={vi.fn()} paths={() => []} context={{}} />
    );
    const { rerender, container } = render(ui("Mine\n"));
    rerender(ui("Theirs\n"));
    expect(container.querySelector("[data-skill-editor]")?.textContent).toBe("Theirs");
    expect(handle.current?.text()).toBe("Theirs\n");
  });

  it("is read-only when the skill is, and still says what it is", () => {
    const { container } = mount("Words\n", { readOnly: true });
    const page = container.querySelector("[data-skill-editor]");
    expect(page?.getAttribute("contenteditable")).toBe("false");
    expect(page?.getAttribute("aria-label")).toBe("Instructions");
    expect(container.querySelector(".doc-tray")).toBeNull();
  });

  it("has no accessibility violations", async () => {
    const { container } = mount("## Title\n\n1. Step\n\n```sh\nls\n```\n\n| a |\n| - |\n| 1 |\n");
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("what a skill holds is safe to show", () => {
  it("never renders imported HTML, only shows it", () => {
    const { container } = mount(
      '<img src="https://example.org/x.png" onerror="alert(1)">\n\n<script>alert(1)</script>\n',
    );
    expect(container.querySelector("img[src]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".doc-opaque")?.textContent).toContain("onerror");
  });

  it("doesn't fetch a remote picture", () => {
    const { container } = mount("![map](https://example.org/map.png)\n");
    // ProseMirror's own spacer is an <img> with no source: nothing here may have one.
    expect(container.querySelector("img[src]")).toBeNull();
    expect(container.querySelector(".doc-image.is-remote")?.textContent).toContain("example.org");
  });

  it("reads a picture only from inside the skill", async () => {
    const imageData = vi.fn(async () => "data:image/png;base64,AAAA");
    const { container } = mount(
      "![map](assets/map.png)\n\n![up](../secret.png)\n\n![abs](/etc/secret.png)\n",
      {
        context: { imageData },
      },
    );
    await waitFor(() =>
      expect(container.querySelector("img[src]")?.getAttribute("src")).toContain("data:image"),
    );
    expect(imageData.mock.calls.map((c) => (c as unknown as string[])[0])).toEqual(["assets/map.png"]);
  });

  it("keeps hidden characters, marks them, and removes them only when asked", () => {
    const source = "A hidden​space\n";
    const { handle, container, view } = mount(source);
    expect(handle.current?.text()).toBe(source);
    expect(container.querySelector(".doc-invisible")?.getAttribute("data-invisible")).toBe("U+200B");
    expect(countInvisibles(view().state.doc).count).toBe(1);
    act(() => removeInvisibles(view()));
    expect(handle.current?.text()).toBe("A hiddenspace\n");
  });
});

describe("paste", () => {
  const $start = parseBody("Text\n").doc.resolve(1);

  it("reads Markdown as content", () => {
    const slice = clipboardTextParser("## Title\n\n- one\n- two\n", $start, false);
    expect(slice.content.child(0).type.name).toBe("heading");
    expect(slice.content.child(1).type.name).toBe("bullet_list");
  });

  it("recognizes code and keeps it whole", () => {
    expect(looksLikeCode("const a = 1;\nconst b = 2;\nfunction c() {\n  return a;\n}\n")).toBe(true);
    expect(looksLikeCode("Just a sentence.\nAnd another one here.\nAnd a third.\n")).toBe(false);
    const slice = clipboardTextParser("  const a = 1;\n  const b = 2;\n  const c = 3;\n", $start, false);
    expect(slice.content.child(0).type.name).toBe("code_block");
    expect(slice.content.child(0).textContent).toBe("const a = 1;\nconst b = 2;\nconst c = 3;");
  });

  it("doesn't touch what was pasted, hidden characters included", () => {
    const slice = clipboardTextParser("Pasted​text", $start, false);
    expect(slice.content.child(0).textContent).toBe("Pasted​text");
  });
});

describe("moving things", () => {
  const SOURCE = "Intro  here\n\n## One\n\nFirst\n\n* star\n\n## Two\n\nSecond\n";

  it("a moved block keeps its bytes", () => {
    const { handle, view } = mount(SOURCE);
    const doc = view().state.doc;
    const first = doc.child(0);
    act(() => {
      moveBlocks(view(), 0, first.nodeSize, doc.content.size);
    });
    const text = handle.current?.text() ?? "";
    expect(text).toContain("Intro  here");
    expect(text.indexOf("Intro")).toBeGreaterThan(text.indexOf("Second"));
    expect(text).toContain("* star");
  });

  it("a heading takes its section with it", () => {
    const { handle, view } = mount(SOURCE);
    const doc = view().state.doc;
    let two = 0;
    doc.forEach((node, pos) => {
      if (node.textContent === "Two") two = pos;
    });
    const one = doc.child(0).nodeSize;
    const range = sectionRange(doc, one);
    expect(range?.to).toBe(two);
    act(() => {
      moveBlocks(view(), range?.from ?? 0, range?.to ?? 0, doc.content.size);
    });
    expect(handle.current?.text()).toBe("Intro  here\n\n## Two\n\nSecond\n\n## One\n\nFirst\n\n* star\n");
  });

  it("dropping something onto itself changes nothing", () => {
    const { handle, view } = mount(SOURCE);
    const size = view().state.doc.child(0).nodeSize;
    act(() => {
      expect(moveBlocks(view(), 0, size, size)).toBeNull();
      expect(moveBlocks(view(), 0, size, 0)).toBeNull();
    });
    expect(handle.current?.text()).toBe(SOURCE);
  });

  it("an item moves between lists, and an emptied list goes with it", () => {
    const { handle, view } = mount("- one\n\ntext\n\n1. two\n2. three\n");
    const doc = view().state.doc;
    const from = 1;
    const to = from + doc.child(0).child(0).nodeSize;
    const ordered = doc.child(0).nodeSize + doc.child(1).nodeSize + 1;
    act(() => {
      moveItem(view(), from, to, ordered);
    });
    const text = handle.current?.text() ?? "";
    expect(text.startsWith("text")).toBe(true);
    expect(text).toContain("one");
    expect(view().state.doc.child(1).childCount).toBe(3);
  });

  it("Alt+arrows move a block from the keyboard", () => {
    const { handle, view } = mount("One\n\nTwo\n\nThree\n");
    act(() => {
      expect(moveBlock(1)(view().state, view().dispatch)).toBe(true);
    });
    expect(handle.current?.text()).toBe("Two\n\nOne\n\nThree\n");
  });

  it("a new piece lands where it's put, with the caret inside, replacing an empty line", () => {
    const { handle, view } = mount("One\n");
    act(() => {
      placeBlocks(view(), view().state.doc.content.size, [
        schema.nodes.heading.create({ level: 2 }, schema.text("New")),
      ]);
    });
    expect(handle.current?.text()).toBe("One\n\n## New\n");
    expect(view().state.selection.$from.parent.textContent).toBe("New");
  });

  it("a piece put on a blank page becomes the page", () => {
    const { handle, view } = mount("");
    act(() => {
      placeBlocks(view(), 0, [schema.nodes.paragraph.create(null, schema.text("First"))]);
    });
    expect(view().state.doc.childCount).toBe(1);
    expect(handle.current?.text()).toContain("First");
  });
});

describe("controls on the page itself", () => {
  it("a checklist box ticks, and the file says so", () => {
    const { handle, view } = mount("- [ ] todo\n- [x] done\n");
    act(() => {
      expect(toggleTask(1)(view().state, view().dispatch)).toBe(true);
    });
    expect(handle.current?.text()).toBe("- [x] todo\n- [x] done\n");
  });

  it("offers the tray's pieces as ordinary buttons, for keyboards", () => {
    const { container } = mount("One\n");
    const tray = within(container.querySelector(".doc-tray") as HTMLElement);
    for (const name of ["Section", "Steps", "Checklist", "Code", "Note", "Table", "File", "Skill"]) {
      expect(tray.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("pressing a piece adds it", () => {
    const { handle, container } = mount("One\n");
    const tray = within(container.querySelector(".doc-tray") as HTMLElement);
    fireEvent.click(tray.getByRole("button", { name: "Section" }));
    expect(handle.current?.text()).toContain("##");
  });

  it("the slash menu lists what can be added, and Escape puts it away", async () => {
    const { view } = mount("\n");
    act(() => view().dispatch(view().state.tr.insertText("/", 1)));
    const list = await screen.findByRole("listbox", { name: "Add to the page" });
    expect(within(list).getByText("Steps")).toBeInTheDocument();
    const handled = view().someProp("handleKeyDown", (f) =>
      f(view(), new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(handled).toBe(true);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Add to the page" })).toBeNull());
  });
});

describe("what the page suggests", () => {
  const doc = (source: string) => parseBody(source).doc;

  it("asks one thing at a time, from what's there", () => {
    expect(nextPrompt(doc(""), "")).toBe(PROMPTS.start);
    expect(nextPrompt(doc(""), "Helps with reports.")).toBe(PROMPTS.approach);
    expect(
      nextPrompt(
        doc("1. Read the data carefully and note what stands out to you\n2. Write it up clearly\n"),
        "x",
      ),
    ).toBe(PROMPTS.result);
  });

  it("goes quiet when the author already covered it", () => {
    expect(
      nextPrompt(
        doc("1. Read every part of it\n2. Write it up clearly please\n\n## Example output\n\nA sample.\n"),
        "x",
      ),
    ).toBeNull();
  });
});

describe("the writer alone", () => {
  it("a role never reaches the Markdown, however it's set", () => {
    const parsed = parseBody("Use the `a-b` skill.\n");
    expect(write(parsed.doc, parsed.baseline).text).toBe("Use the `a-b` skill.\n");
  });
});
