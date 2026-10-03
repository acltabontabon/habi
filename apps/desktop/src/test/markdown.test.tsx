import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "../components/Markdown";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

describe("skill Markdown rendering", () => {
  it("drops raw HTML and neutralizes dangerous links", () => {
    const hostile = [
      "# Title",
      "<script>window.pwned = true</script>",
      '<img src="x" onerror="window.pwned = true">',
      "[click](javascript:alert(1))",
      "[docs](https://example.invalid/docs)",
      "![tracker](https://example.invalid/pixel.png)",
    ].join("\n\n");
    const { container } = render(<Markdown text={hostile} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href")?.startsWith("javascript:")).toBe(false);
    }
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(container.textContent).toContain("[image: tracker]");
  });

  it("highlights fenced code it knows, as text, and leaves the rest plain", () => {
    const md = [
      "```python",
      "def check():",
      '    return "ok"',
      "```",
      "",
      "```brainfuck",
      "+++",
      "```",
      "",
      "Run `ls`.",
    ].join("\n");
    const { container } = render(<Markdown text={md} />);
    const blocks = container.querySelectorAll("pre code");
    expect(blocks[0]?.querySelector(".tok-keyword")?.textContent).toBe("def");
    expect(blocks[0]?.querySelector(".tok-string")?.textContent).toBe('"ok"');
    expect(blocks[0]?.textContent).toBe('def check():\n    return "ok"');
    expect(blocks[1]?.querySelector("span")).toBeNull();
    // Inline code stays as it was.
    expect(container.querySelector("p code")?.textContent).toBe("ls");
  });
});
