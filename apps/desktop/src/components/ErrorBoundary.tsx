/**
 * Catches errors while a screen renders: logs them for diagnostics and
 * offers a way out instead of a blank window.
 */
import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { logUiError } from "../lib/uiErrors";
import { Button, ErrorNotice } from "./ui";

type Props = {
  children: ReactNode;
  /** Where the boundary sits, for the log. */
  area: string;
};

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    logUiError(error, `while showing ${this.props.area}${info.componentStack ?? ""}`);
  }

  override render() {
    return this.state.error ? <Fallback error={this.state.error} /> : this.props.children;
  }
}

/** Works without the app's providers: the top-level boundary sits outside them. */
function Fallback({ error }: { error: Error }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await api.diagnosticsSave());
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="startup">
      <ErrorNotice error={error} title="Habi could not show this screen" />
      <p className="muted">
        Nothing in your projects was changed. Reload to carry on; if it happens again, save a diagnostic
        report — it includes this error — and attach it when you ask for help.
      </p>
      <div className="form-actions">
        <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button busy={saving} onClick={() => void save()}>
          Save diagnostics…
        </Button>
      </div>
      {saved ? <p className="muted">Saved to {saved}</p> : null}
      {saveError ? <ErrorNotice error={saveError} title="The report was not saved" /> : null}
    </div>
  );
}
