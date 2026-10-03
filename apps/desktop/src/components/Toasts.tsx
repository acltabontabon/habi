/**
 * Transient confirmations announced to screen readers. Errors are announced
 * at once and stay until dismissed; others pause while hovered or focused.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Tone } from "../lib/format";
import { Icon } from "./Icon";

/** One thing to do about what just happened — usually taking it back. */
export type ToastAction = { label: string; run: () => void };
type Toast = { id: number; tone: Tone; text: string; action?: ToastAction };
type Toaster = { show: (text: string, tone?: Tone, action?: ToastAction) => void };

const ToastContext = createContext<Toaster>({ show: () => {} });
const SHOWN_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback((text: string, tone: Tone = "ok", action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text, action }]);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const { id, tone } = toast;
  useEffect(() => {
    if (tone === "danger" || held) return;
    const timer = window.setTimeout(() => onDismiss(id), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [id, tone, held, onDismiss]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering or focusing only pauses dismissal.
    <div
      className={`toast tone-${tone}`}
      role={tone === "danger" ? "alert" : undefined}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
    >
      <span>{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          className="link-btn toast-action"
          onClick={() => {
            toast.action?.run();
            onDismiss(id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
