/**
 * Keyboard behaviour shared by tab lists (WAI-ARIA tabs pattern): ←/→ move
 * between tabs and select them, Home/End jump to the ends. Only the selected
 * tab is in the Tab order.
 */
import type { KeyboardEvent } from "react";

export function tabKeyHandler<T extends string>(
  ids: readonly T[],
  current: T,
  select: (id: T) => void,
  domId: (id: T) => string,
) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const index = ids.indexOf(current);
    let next: T | undefined;
    if (e.key === "ArrowRight") next = ids[(index + 1) % ids.length];
    else if (e.key === "ArrowLeft") next = ids[(index + ids.length - 1) % ids.length];
    else if (e.key === "Home") next = ids[0];
    else if (e.key === "End") next = ids[ids.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    const target = next;
    select(target);
    requestAnimationFrame(() => document.getElementById(domId(target))?.focus());
  };
}
