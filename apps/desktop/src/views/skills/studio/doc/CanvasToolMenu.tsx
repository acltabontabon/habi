import { type ReactNode, useEffect, useRef } from "react";

/** Native disclosure keeps the canvas quiet without hiding the available paths. */
export function CanvasToolMenu({
  label,
  glyph,
  children,
}: {
  label: string;
  glyph: string;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, []);
  return (
    <details
      ref={menu}
      className="canvas-tool-menu"
      name="canvas-tools"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.open) {
          event.preventDefault();
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        <span aria-hidden="true">{glyph}</span>
        {label}
        <span className="tool-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="canvas-tool-popover">{children}</div>
    </details>
  );
}
