import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { DiagnosticBundle } from "../bindings/DiagnosticBundle";
import type { Settings } from "../bindings/Settings";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Section, Status, Working } from "../components/ui";
import { api } from "../lib/api";
import { pruneSummary } from "../lib/format";
import { REPOSITORY } from "../lib/links";
import { useNav } from "../lib/nav";
import { keys, useAppInfo, useSettings } from "../lib/queries";
import { useOpenExternal } from "../lib/safeInvoke";
import { RemoveSampleDialog, useHasSample } from "./SampleWorkspace";
import { UpdateStatus } from "./UpdateStatus";

export function SettingsView() {
  const settings = useSettings();
  const info = useAppInfo();
  const client = useQueryClient();
  const toast = useToast();
  const openExternal = useOpenExternal();
  const { navigate } = useNav();
  const [bundle, setBundle] = useState<DiagnosticBundle | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hasSample = useHasSample();
  const [removingSample, setRemovingSample] = useState(false);
  const [freeing, setFreeing] = useState(false);
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

  const freeUpSpace = async () => {
    setFreeing(true);
    try {
      toast.show(pruneSummary(await api.freeUpSpace()));
      void client.invalidateQueries({ queryKey: ["history"] });
    } catch (e) {
      toast.show(`Space was not freed: ${e instanceof Error ? e.message : String(e)}`, "danger");
    } finally {
      setFreeing(false);
    }
  };

  return (
    <div className="page narrow">
      <h1 className="page-title">Settings</h1>

      <Section title="Library updates" id="refresh">
        <label className="field">
          <span className="field-label">Check connected libraries for new versions</span>
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
          Checking only asks the repository whether it has something newer. Nothing is downloaded and no
          library changes until you press Update, and an update never changes a project: adopting a skill
          always goes through a preview. Checks pause while the window is hidden or the network is offline.
        </p>
      </Section>

      <Section title="Habi updates" id="updates">
        <label className="field">
          <span className="field-label">Look for a newer version of Habi</span>
          <select
            className="input"
            value={s.checkForUpdates ? "auto" : "manual"}
            onChange={(e) => {
              const on = e.target.value === "auto";
              save((current) => ({ ...current, checkForUpdates: on }));
            }}
          >
            <option value="auto">Automatically while Habi is open</option>
            <option value="manual">Only when I ask</option>
          </select>
        </label>
        <UpdateStatus />
        <p className="muted">
          Checking downloads one small file from this project's GitHub releases; nothing about you or your
          projects is sent. A new version installs only when you press Update, and is verified against Habi's
          signing key first.
        </p>
      </Section>

      <Section title="Data and space" id="data">
        <div className="settings-row">
          <p className="muted">
            Habi keeps each project's newest 20 operations, so they can be restored, and each library's newest
            20 earlier snapshots. Free up space removes anything older, and stored file versions nothing
            refers to. Unfinished operations and ones that need attention are always kept.
          </p>
          <Button busy={freeing} onClick={() => void freeUpSpace()}>
            Free up space
          </Button>
        </div>
        {hasSample ? (
          <div className="settings-row">
            <p className="muted">
              The sample workspace is here: example libraries and projects, labeled "sample".
            </p>
            <Button onClick={() => setRemovingSample(true)}>Remove sample workspace…</Button>
          </div>
        ) : null}
        <RemoveSampleDialog open={removingSample} onOpenChange={setRemovingSample} />
      </Section>

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
          <dd>
            {info.data?.version}{" "}
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "about" })}>
              What's new
            </button>
          </dd>
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
        </dl>
      </Section>
    </div>
  );
}
