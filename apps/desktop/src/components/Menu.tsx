/**
 * A menu button: a short list of actions behind one control. Arrow keys,
 * Home/End and type-ahead move between items; Enter or Space chooses; Escape
 * and Tab close it and return focus to the button. Items can be grouped and
 * explained in one quiet line.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type MenuItem = {
  label: string;
  /** One quiet line under the label. */
  hint?: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function Menu({
  label,
  trigger,
  items,
  align = "end",
  className,
}: {
  /** Accessible name of the button. */
  label: string;
  /** What the button shows; an ellipsis icon when omitted. */
  trigger?: ReactNode;
  /** Items, or groups of items separated by a hairline. */
  items: (MenuItem | MenuItem[])[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const groups = items.map((g) => (Array.isArray(g) ? g : [g])).filter((g) => g.length > 0);

  const entries = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const focusAt = (index: number) => {
    const all = entries().filter((e) => !e.disabled);
    all[(index + all.length) % all.length]?.focus();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusAt reads the live list.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => focusAt(0));
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const all = entries().filter((x) => !x.disabled);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") focusAt(at + 1);
    else if (e.key === "ArrowUp") focusAt(at - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(all.length - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const next = all.findIndex(
        (x, i) => i > at && x.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()),
      );
      const wrap = all.findIndex((x) => x.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (next >= 0) focusAt(next);
      else if (wrap >= 0) focusAt(wrap);
      else return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className={`menu${className ? ` ${className}` : ""}`}>
      <button
        ref={button}
        type="button"
        className={trigger ? "menu-trigger" : "menu-trigger is-icon"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={trigger ? undefined : label}
        title={trigger ? undefined : label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? <Icon name="more" />}
      </button>
      {open ? (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={`menu-list is-${align}`}
          tabIndex={-1}
          onKeyDown={onKey}
        >
          {groups.map((group, g) => (
            <div key={g} className="menu-group">
              {g > 0 ? <hr className="menu-sep" /> : null}
              {group.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`menu-item${item.danger ? " is-danger" : ""}`}
                  disabled={item.disabled}
                  tabIndex={-1}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu-gap" />}
                  <span className="menu-text">
                    <span>{item.label}</span>
                    {item.hint ? <span className="menu-hint">{item.hint}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
