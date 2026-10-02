/** Small building blocks: buttons, status facets, notices, empty states. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { HabiError } from "../lib/api";
import type { Tone } from "../lib/format";
import { Icon, type IconName } from "./Icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
  icon?: IconName;
  busy?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  // `disabled` is destructured so a caller's `disabled={false}` can never
  // re-enable a busy button (which would let a double click apply twice).
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`}
      aria-busy={busy || undefined}
      disabled={Boolean(disabled || busy)}
    >
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

const toneIcon: Record<Tone, IconName> = {
  ok: "check",
  unknown: "question",
  warn: "warning",
  danger: "warning",
  muted: "minus",
  thread: "dot",
};

/** One independent status fact: a label, a value, a tone. */
export function Facet({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}) {
  return (
    <div className={`facet tone-${tone}`}>
      <dt className="facet-label">{label}</dt>
      <dd className="facet-value">
        <Icon name={toneIcon[tone]} size={14} />
        {value}
      </dd>
      {detail ? <dd className="facet-detail">{detail}</dd> : null}
    </div>
  );
}

/** Inline status word with an icon; color is never the only signal. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status tone-${tone}`}>
      <Icon name={toneIcon[tone]} size={13} />
      {children}
    </span>
  );
}

export function Label({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`label tone-${tone}`}>{children}</span>;
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice tone-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "ok" ? "check" : tone === "unknown" || tone === "muted" ? "info" : "warning"} />
      <div className="notice-body">
        {title ? <p className="notice-title">{title}</p> : null}
        {children ? <div className="notice-text">{children}</div> : null}
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

const guidance: Record<string, string> = {
  gitNetwork: "Check your network or VPN. Anything fetched earlier stays available.",
  gitAuthentication:
    "Git could not authenticate. Habi uses your existing Git credentials: try `git fetch` in a terminal, or load your SSH key into the agent.",
  gitNotFound: "The repository, branch or tag was not found, or your account cannot see it.",
  gitMissing: "Install Git and make sure it is on your PATH.",
  stalePlan: "Files changed after the preview. Review the new preview before applying.",
  busy: "Another Habi window or the CLI is working on this. Try again in a moment.",
  permissionDenied: "Habi was not allowed to read or write a file. Check the folder's permissions.",
  diskFull: "The disk is full. Free some space; nothing was partially applied.",
};

export function ErrorNotice({
  error,
  title,
  action,
}: {
  error: unknown;
  title?: string;
  action?: ReactNode;
}) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HabiError ? error.code : "internal";
  return (
    <Notice tone="danger" title={title ?? "Something went wrong"} action={action}>
      <p>{message}</p>
      {guidance[code] ? <p className="muted">{guidance[code]}</p> : null}
    </Notice>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Section({
  title,
  aside,
  children,
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id} className="section-title">
          {title}
        </h3>
        {aside ? <div className="section-aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A quiet "loading" line; no spinners or infinite animation. */
export function Working({ children, onCancel }: { children: ReactNode; onCancel?: () => void }) {
  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-thread" aria-hidden="true" />
      <span>{children}</span>
      {onCancel ? (
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
