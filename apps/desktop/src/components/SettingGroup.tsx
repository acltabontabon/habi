/** Settings hang from one thread like warp: a titled group with its knot, and a row per setting under it. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export function SettingGroup({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="set-group" aria-labelledby={id}>
      <h2 id={id} className="set-title">
        {title}
      </h2>
      <div className="set-items">{children}</div>
    </section>
  );
}

/**
 * One setting as a row: its name and a line of context on the left, and what
 * to choose or do about it on the right. On a narrow page the control drops
 * beneath the words.
 */
export function Setting({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  /** The control needs the row's width (a list): it goes beneath the words. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={wide ? "setting is-wide" : "setting"}>
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint ? <p className="setting-hint">{hint}</p> : null}
      </div>
      {children ? <div className="setting-control">{children}</div> : null}
    </div>
  );
}

/** What to do about a setting: always a verb, always the same quiet shape, a thread beneath and an arrow ahead. */
export function SettingAction({
  busy,
  children,
  ...rest
}: { busy?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className">) {
  return (
    <button type="button" className="set-action" aria-busy={busy || undefined} disabled={busy} {...rest}>
      {children}
      {busy ? <span aria-hidden="true">…</span> : <Icon name="chevronRight" size={12} />}
    </button>
  );
}
