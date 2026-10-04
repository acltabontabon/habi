import { fireEvent, render } from "@testing-library/react";
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
      // No link carries an href at all: the webview must have nothing to navigate to.
      expect(a.getAttribute("href")).toBeNull();
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

  it("highlights shell, TypeScript, YAML and JSON without the editor", () => {
    const md = [
      "```bash",
      "# install it",
      'if [ -f x ]; then echo "found $HOME"; fi',
      "```",
      "",
      "```ts",
      "const n: number = 1;",
      "```",
      "",
      "```yaml",
      "name: review",
      "```",
      "",
      "```json",
      '{"ok": true}',
      "```",
    ].join("\n");
    const { container } = render(<Markdown text={md} />);
    const [sh, ts, yaml, json] = [...container.querySelectorAll("pre code")];
    expect(sh?.querySelector(".tok-comment")?.textContent).toBe("# install it");
    expect([...(sh?.querySelectorAll(".tok-keyword") ?? [])].map((e) => e.textContent)).toContain("then");
    expect(sh?.querySelector(".tok-string")).not.toBeNull();
    expect(sh?.textContent).toBe('# install it\nif [ -f x ]; then echo "found $HOME"; fi');
    expect(ts?.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(ts?.querySelector(".tok-typeName")?.textContent).toBe("number");
    expect(yaml?.querySelector(".tok-propertyName, .tok-definition")).not.toBeNull();
    expect(json?.querySelector(".tok-bool")?.textContent).toBe("true");
  });

  it("opens https links through Habi, never by navigating the window", () => {
    invoke.mockClear();
    const { getByRole } = render(<Markdown text="[docs](https://example.invalid/docs)" />);
    const link = getByRole("link", { name: "docs" });
    expect(link.hasAttribute("href")).toBe(false);
    expect(link.getAttribute("title")).toBe("Opens https://example.invalid/docs in your browser");
    for (const type of ["auxclick", "contextmenu"]) {
      expect(fireEvent(link, new MouseEvent(type, { bubbles: true, cancelable: true }))).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("open_external", { url: "https://example.invalid/docs" });
  });
});
