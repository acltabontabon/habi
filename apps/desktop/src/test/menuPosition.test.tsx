import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Menu } from "../components/Menu";

it("keeps an edge menu outside clipping parents and inside the viewport", () => {
  const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    return (
      this.getAttribute("role") === "menu"
        ? { left: 0, top: 0, right: 232, bottom: 200, width: 232, height: 200 }
        : {
            left: 8,
            top: window.innerHeight - 40,
            right: 40,
            bottom: window.innerHeight - 12,
            width: 32,
            height: 28,
          }
    ) as DOMRect;
  });
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
  const { unmount } = render(
    <div style={{ overflow: "hidden" }}>
      <Menu label="File actions" items={[{ label: "Rename", onSelect: vi.fn() }]} />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "File actions" });
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "File actions" });
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.position).toBe("fixed");
  expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(menu.style.top) + 200).toBeLessThan(window.innerHeight - 40);
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  unmount();
  bounds.mockRestore();
  height.mockRestore();
});
