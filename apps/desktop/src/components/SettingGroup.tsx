/** Settings hang from one thread like warp: a titled group with its knot, and the settings under it. */
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

/** One setting: its name and a line of context, then what to choose or do about it beneath. */
export function Setting({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      {hint ? <p className="setting-hint">{hint}</p> : null}
      {children}
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
