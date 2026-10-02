/** Transient confirmations announced to screen readers. Dismissible, not timed for errors. */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { Tone } from "../lib/format";
import { Icon } from "./Icon";

type Toast = { id: number; tone: Tone; text: string };
type Toaster = { show: (text: string, tone?: Tone) => void };

const ToastContext = createContext<Toaster>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, tone: Tone = "ok") => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, tone, text }]);
      if (tone !== "danger") window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
