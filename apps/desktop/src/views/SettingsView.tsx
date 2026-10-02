import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import pkg from "../../package.json";
import type { ClientId } from "../bindings/ClientId";
import type { DiagnosticBundle } from "../bindings/DiagnosticBundle";
import type { Settings } from "../bindings/Settings";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Section, Status, Working } from "../components/ui";
import { api } from "../lib/api";
import { ALL_CLIENTS, clientLabel } from "../lib/format";
import { keys, useAppInfo, useSettings } from "../lib/queries";
import { useOpenExternal } from "../lib/safeInvoke";
import { type ThemeChoice, useTheme } from "../lib/theme";
import { RemoveSampleDialog, useHasSample } from "./SampleWorkspace";

/** The repository Habi is developed in (from package.json). */
const REPOSITORY = pkg.repository.url.replace(/\.git$/, "");

export function SettingsView() {
  const settings = useSettings();
  const info = useAppInfo();
  const client = useQueryClient();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const openExternal = useOpenExternal();
  const [bundle, setBundle] = useState<DiagnosticBundle | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hasSample = useHasSample();
  const [removingSample, setRemovingSample] = useState(false);
  // Writes go one after another, each built on the latest settings, so two
  // quick toggles cannot overwrite each other with a stale copy.
  const queue = useRef<Promise<void>>(Promise.resolve());

  if (settings.isPending || info.isPending) return <Working>Loading settings…</Working>;
  if (settings.isError) return <ErrorNotice error={settings.error} />;
  const s = settings.data;

  const save = (change: (current: Settings) => Settings) => {
    const current = client.getQueryData<Settings>(keys.settings) ?? s;
    const next = change(current);
    client.setQueryData(keys.settings, next);
    queue.current = queue.current.then(async () => {
      try {
        await api.setSettings(next);
      } catch (e) {
        toast.show(`Settings not saved: ${e instanceof Error ? e.message : String(e)}`, "danger");
        void client.invalidateQueries({ queryKey: keys.settings });
      }
    });
  };

  const toggleClient = (c: ClientId) =>
    save((current) => {
      const next = current.defaultClients.includes(c)
        ? current.defaultClients.filter((x) => x !== c)
        : [...current.defaultClients, c];
      return { ...current, defaultClients: ALL_CLIENTS.filter((x) => next.includes(x)) };
    });

  return (
    <div className="page narrow">
      <h1 className="page-title">Settings</h1>

      <Section title="Installing" id="install">
        <fieldset className="field">
          <legend className="field-label">Preselected clients in install previews</legend>
          {ALL_CLIENTS.map((c) => (
            <label key={c} className="check">
              <input
                type="checkbox"
                checked={s.defaultClients.includes(c)}
                onChange={() => toggleClient(c)}
              />
              <span>{clientLabel[c]}</span>
            </label>
          ))}
        </fieldset>
        <p className="muted">
          Habi installs into the selected project only. It does not change global agent settings.
        </p>
      </Section>

      <Section title="Library refresh" id="refresh">
        <label className="field">
          <span className="field-label">Check connected libraries for new content</span>
          <select
            className="input"
            value={s.autoRefreshHours}
            onChange={(e) => {
              const hours = Number(e.target.value);
              save((current) => ({ ...current, autoRefreshHours: hours }));
            }}
          >
            <option value={0}>Only when I ask</option>
            <option value={6}>Every 6 hours while Habi is open</option>
            <option value={12}>Every 12 hours while Habi is open</option>
            <option value={24}>Once a day while Habi is open</option>
          </select>
        </label>
        <p className="muted">
          Refreshing only downloads library content. It never changes a project; adopting an update always
          goes through a preview. Scheduled refresh pauses while the window is hidden or the network is
          offline.
        </p>
      </Section>

      <Section title="Appearance" id="appearance">
        <fieldset className="field">
          <legend className="field-label">Theme</legend>
          <div className="segmented">
            {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
              <label key={t} className="radio">
                <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
                {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      {hasSample ? (
        <Section title="Data" id="data">
          <div className="settings-row">
            <p className="muted">
              The sample workspace is here: example libraries and projects, labeled "sample".
            </p>
            <Button onClick={() => setRemovingSample(true)}>Remove sample workspace…</Button>
          </div>
          <RemoveSampleDialog open={removingSample} onOpenChange={setRemovingSample} />
        </Section>
      ) : null}

      <Section title="Diagnostics" id="diagnostics">
        <p className="muted">
          A redacted report for troubleshooting: versions, library health and recent log lines. It never
          includes library content, project files, environment values or credentials. Review it before saving.
        </p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="form-actions">
          <Button onClick={() => void api.diagnosticsPreview().then(setBundle).catch(setError)}>
            Preview report
          </Button>
          {bundle ? (
            <Button
              variant="primary"
              onClick={() =>
                void api
                  .diagnosticsSave()
                  .then((path) => path && toast.show(`Saved to ${path}`))
                  .catch(setError)
              }
            >
              Save report…
            </Button>
          ) : null}
        </div>
        {bundle ? <pre className="code output diagnostics-preview">{bundle.text}</pre> : null}
      </Section>

      <Section title="About" id="about">
        <dl className="meta-grid">
          <dt>Version</dt>
          <dd>{info.data?.version}</dd>
          <dt>Source</dt>
          <dd>
            <button type="button" className="link-quiet" onClick={() => openExternal(REPOSITORY)}>
              {REPOSITORY.replace("https://", "")}
            </button>{" "}
            <span className="muted">· open source, Apache-2.0</span>
          </dd>
          <dt>Data folder</dt>
          <dd className="mono">{info.data?.dataDir}</dd>
          <dt>Git</dt>
          <dd>
            <Status tone={info.data?.gitAvailable ? "ok" : "warn"}>
              {info.data?.gitAvailable ? "found" : "not found"}
            </Status>
          </dd>
          <dt>GitHub CLI</dt>
          <dd>
            <Status tone={info.data?.ghAvailable ? "ok" : "muted"}>
              {info.data?.ghAvailable ? "found" : "not found"}
            </Status>
          </dd>
          <dt>GitLab CLI</dt>
          <dd>
            <Status tone={info.data?.glabAvailable ? "ok" : "muted"}>
              {info.data?.glabAvailable ? "found" : "not found"}
            </Status>
          </dd>
          <dt>Privacy</dt>
          <dd>No account, no telemetry. Inspection and matching run on this machine.</dd>
          <dt>Updates</dt>
          <dd>Habi does not update itself. Install new versions manually from your release source.</dd>
        </dl>
      </Section>
    </div>
  );
}
