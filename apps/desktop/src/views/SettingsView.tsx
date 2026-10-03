import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { DiagnosticBundle } from "../bindings/DiagnosticBundle";
import type { Settings } from "../bindings/Settings";
import { Dialog } from "../components/Dialog";
import { Setting, SettingAction, SettingGroup } from "../components/SettingGroup";
import { ThreadChoice } from "../components/ThreadChoice";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Status, Working } from "../components/ui";
import { api } from "../lib/api";
import { pruneSummary } from "../lib/format";
import { keys, useAppInfo, useSettings } from "../lib/queries";
import { RemoveSampleDialog, useHasSample } from "./SampleWorkspace";

const UPDATE_CHOICES = [
  { value: "manual", label: "Manual", description: "Only when I ask" },
  { value: "auto", label: "Automatic", description: "Look for updates while the app is open" },
];

const REFRESH_CHOICES = [
  { value: 0, label: "Manual", description: "Only when I ask" },
  { value: 6, label: "6 h", description: "Every 6 hours" },
  { value: 12, label: "12 h", description: "Every 12 hours" },
  { value: 24, label: "Daily", description: "Once a day" },
];

export function SettingsView() {
  const settings = useSettings();
  const info = useAppInfo();
  const client = useQueryClient();
  const toast = useToast();
  const [bundle, setBundle] = useState<DiagnosticBundle | null>(null);
  const [building, setBuilding] = useState(false);
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

  const closeReport = () => {
    setBundle(null);
    setError(null);
  };

  const previewReport = async () => {
    setBuilding(true);
    setError(null);
    try {
      setBundle(await api.diagnosticsPreview());
    } catch (e) {
      setError(e);
    } finally {
      setBuilding(false);
    }
  };

  const saveReport = async () => {
    try {
      const path = await api.diagnosticsSave();
      if (path) {
        toast.show(`Saved to ${path}`);
        closeReport();
      }
    } catch (e) {
      setError(e);
    }
  };

  const tools = [
    { name: "Git", found: info.data?.gitAvailable, missing: "warn" as const },
    { name: "GitHub CLI", found: info.data?.ghAvailable, missing: "muted" as const },
    { name: "GitLab CLI", found: info.data?.glabAvailable, missing: "muted" as const },
  ];

  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>

      <div className="set-warp">
        <SettingGroup title="Updates" id="updates">
          <Setting label="Check libraries" hint="Nothing changes until you press Update.">
            <ThreadChoice
              label="Check connected libraries for new versions"
              value={s.autoRefreshHours}
              options={REFRESH_CHOICES}
              onChange={(hours) => save((current) => ({ ...current, autoRefreshHours: hours }))}
            />
          </Setting>
          <Setting
            label="Check for new releases"
            hint="One small signed file from GitHub; nothing about you is sent."
          >
            <ThreadChoice
              label="Look for a newer version"
              value={s.checkForUpdates ? "auto" : "manual"}
              options={UPDATE_CHOICES}
              onChange={(mode) => save((current) => ({ ...current, checkForUpdates: mode === "auto" }))}
            />
          </Setting>
        </SettingGroup>

        <SettingGroup title="Storage" id="storage">
          <Setting
            label="Old history"
            hint="Clears history beyond the latest 20 operations per project and 20 snapshots per library. Unfinished work stays."
          >
            <SettingAction busy={freeing} onClick={() => void freeUpSpace()}>
              Free up space
            </SettingAction>
          </Setting>
          {hasSample ? (
            <Setting label="Sample workspace" hint="Example libraries and projects, labeled “sample”.">
              <SettingAction onClick={() => setRemovingSample(true)}>Remove sample</SettingAction>
            </Setting>
          ) : null}
        </SettingGroup>

        <SettingGroup title="This machine" id="machine">
          <Setting label="Command-line tools">
            <ul className="tool-list">
              {tools.map((t) => (
                <li key={t.name} className="tool">
                  <span className="tool-name">{t.name}</span>
                  <Status tone={t.found ? "ok" : t.missing}>{t.found ? "found" : "not found"}</Status>
                </li>
              ))}
            </ul>
          </Setting>
          <Setting label="Data folder">
            <code className="data-path">{info.data?.dataDir}</code>
          </Setting>
        </SettingGroup>

        <SettingGroup title="Diagnostics" id="diagnostics">
          <Setting
            label="Troubleshooting report"
            hint="Versions, library health and recent log lines, redacted. Never any content, files or credentials."
          >
            {error && !bundle ? <ErrorNotice error={error} /> : null}
            <SettingAction busy={building} onClick={() => void previewReport()}>
              Preview report
            </SettingAction>
          </Setting>
        </SettingGroup>
      </div>

      <RemoveSampleDialog open={removingSample} onOpenChange={setRemovingSample} />

      <Dialog
        open={bundle !== null}
        onOpenChange={(open) => {
          if (!open) closeReport();
        }}
        title="Diagnostic report"
        description="Read it through before saving. It is only written to disk when you save."
        wide
        footer={
          <>
            <Button variant="quiet" onClick={closeReport}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void saveReport()}>
              Save report…
            </Button>
          </>
        }
      >
        {error ? <ErrorNotice error={error} /> : null}
        <pre className="code output diagnostics-preview">{bundle?.text}</pre>
      </Dialog>
    </div>
  );
}
