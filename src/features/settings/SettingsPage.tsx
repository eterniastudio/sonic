import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  Bug,
  Check,
  CloudArrowDown,
  DownloadSimple,
  FloppyDisk,
  FolderOpen,
  HardDrives,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatBytes, shortPath } from "../../domain/format";
import type { SonicSettings } from "../../domain/types";

export function SettingsPage() {
  const {
    state,
    bridgeMode,
    chooseOutputDirectory,
    saveSettings,
    refreshDiagnostics,
    exportDiagnostics,
    prepareEngine,
    updater,
    checkForUpdates,
    installUpdate,
  } = useSonic();
  const [draft, setDraft] = useState<SonicSettings>(state.settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(state.settings), [state.settings]);

  const update = <Key extends keyof SonicSettings>(key: Key, value: SonicSettings[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try { await saveSettings(draft); } finally { setSaving(false); }
  };

  const engine = state.diagnostics.engine;
  const updateBusy = updater.phase === "checking" || updater.phase === "downloading" || updater.phase === "installing";
  const updateProgress = updater.totalBytes
    ? Math.min(100, Math.round((updater.downloadedBytes / updater.totalBytes) * 100))
    : undefined;
  const updateHeading = updater.phase === "available"
    ? `Sonic ${updater.availableVersion} is ready`
    : updater.phase === "downloading"
      ? "Downloading update"
      : updater.phase === "installing"
        ? "Installing update"
        : updater.phase === "upToDate"
          ? "You’re up to date"
          : updater.phase === "checking"
            ? "Checking for updates"
            : updater.phase === "unavailable"
              ? "Desktop updates"
              : updater.phase === "error"
                ? "Update check needs attention"
                : "Automatic updates";

  return (
    <main className="settings-page" aria-labelledby="settings-heading">
      <header className="page-heading settings-heading">
        <div><span className="eyebrow">Workspace</span><h1 id="settings-heading">Settings</h1><p>Defaults, naming, safety limits, and the verified local engine.</p></div>
        <button className="primary-action save-settings" type="button" disabled={saving} onClick={() => void save()}><FloppyDisk size={18} weight="bold" aria-hidden="true" />{saving ? "Saving…" : "Save changes"}</button>
      </header>

      <div className="settings-columns">
        <div className="settings-main">
          <section className="settings-section" aria-labelledby="general-settings">
            <header><div><span className="eyebrow">General</span><h2 id="general-settings">Session defaults</h2></div><FolderOpen size={21} aria-hidden="true" /></header>
            <button className="path-button" type="button" onClick={() => void chooseOutputDirectory()}>
              <FolderOpen size={17} aria-hidden="true" />
              <span><small>Default output folder</small><strong>{draft.defaultOutputDirectory ? shortPath(draft.defaultOutputDirectory, 68) : "Choose a folder"}</strong></span>
            </button>
            <div className="settings-field-grid">
              <label className="field"><span>Default export preset</span><select value={draft.defaultPresetId} onChange={(event) => update("defaultPresetId", event.target.value as SonicSettings["defaultPresetId"])}>{state.presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>
              <label className="field"><span>Queue concurrency</span><select value={draft.maxConcurrentJobs} onChange={(event) => update("maxConcurrentJobs", Number(event.target.value))}><option value={1}>1 export · safest</option><option value={2}>2 exports</option><option value={3}>3 exports</option></select></label>
            </div>
            <div className="settings-switches">
              <label className="switch-field"><input type="checkbox" checked={draft.historyEnabled} onChange={(event) => update("historyEnabled", event.target.checked)} /><span><b>Keep local history</b><small>Add completed exports to the Beat Library</small></span></label>
              <label className="switch-field"><input type="checkbox" checked={draft.writeEmbeddedTags} onChange={(event) => update("writeEmbeddedTags", event.target.checked)} /><span><b>Write embedded tags</b><small>Use supported BPM, key, and title fields</small></span></label>
              <label className="switch-field"><input type="checkbox" checked={draft.includeSourcePathInSidecar} onChange={(event) => update("includeSourcePathInSidecar", event.target.checked)} /><span><b>Include source location in sidecar</b><small>Off by default for more private local records</small></span></label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="naming-settings">
            <header><div><span className="eyebrow">Naming</span><h2 id="naming-settings">Filename template</h2></div><FloppyDisk size={21} aria-hidden="true" /></header>
            <label className="field"><span>Default template</span><textarea rows={3} value={draft.filenameTemplate} onChange={(event) => update("filenameTemplate", event.target.value)} /></label>
            <div className="template-presets">
              {draft.templates.map((template) => <button type="button" key={template.id} className={draft.filenameTemplate === template.template ? "is-selected" : ""} onClick={() => { update("filenameTemplate", template.template); update("defaultTemplateId", template.id); }}><strong>{template.name}</strong><small>{template.template}</small></button>)}
            </div>
            <p className="settings-note">Available tokens: <code>{"{title}"}</code> <code>{"{producer}"}</code> <code>{"{bpm}"}</code> <code>{"{key}"}</code> <code>{"{camelot}"}</code> <code>{"{detune}"}</code> <code>{"{preset}"}</code> <code>{"{source}"}</code> <code>{"{date}"}</code></p>
          </section>

          <section className="settings-section" aria-labelledby="safety-settings">
            <header><div><span className="eyebrow">Guardrails</span><h2 id="safety-settings">Intake limits</h2></div><ShieldCheck size={21} aria-hidden="true" /></header>
            <div className="settings-field-grid">
              <label className="field"><span>Maximum duration</span><span className="input-with-unit"><input type="number" min="1" max="360" value={draft.maxDurationMinutes} onChange={(event) => update("maxDurationMinutes", Number(event.target.value))} /><b>minutes</b></span></label>
              <label className="field"><span>Maximum input size</span><span className="input-with-unit"><input type="number" min="1" max="20" step="0.5" value={Math.round(draft.maxInputBytes / 107_374_182.4) / 10} onChange={(event) => update("maxInputBytes", Math.round(Number(event.target.value) * 1024 ** 3))} /><b>GB</b></span></label>
            </div>
            <p className="settings-note">Sonic validates these limits before processing local media. Current maximum input is {formatBytes(draft.maxInputBytes)}.</p>
          </section>
        </div>

        <aside className="settings-side">
          <section className={`settings-section update-section is-${updater.phase}`} aria-labelledby="update-settings">
            <header>
              <div><span className="eyebrow">Software update</span><h2 id="update-settings">{updateHeading}</h2></div>
              {updater.phase === "upToDate" ? <Check className="status-good" size={22} weight="bold" aria-hidden="true" /> : <CloudArrowDown className={updater.phase === "error" ? "status-warning" : "update-icon"} size={22} weight="bold" aria-hidden="true" />}
            </header>
            <div className="update-copy">
              <p>
                {updater.phase === "available" || (updater.phase === "error" && updater.availableVersion)
                  ? `Signed update ${updater.availableVersion} is available. Sonic verifies it before installation.`
                  : updater.phase === "downloading"
                    ? `Downloaded ${formatBytes(updater.downloadedBytes)}${updater.totalBytes ? ` of ${formatBytes(updater.totalBytes)}` : ""}.`
                    : updater.phase === "installing"
                      ? "Sonic will close, finish installation, and reopen on the new version."
                      : updater.phase === "upToDate"
                        ? `This installation is current at version ${state.diagnostics.appVersion}.`
                        : updater.phase === "unavailable"
                          ? "Update checks run inside the installed desktop app, not the browser preview."
                          : updater.phase === "checking"
                            ? "Contacting Eternia Studios releases and validating update metadata."
                            : "Sonic checks Eternia Studios releases shortly after startup. Installation always requires your confirmation."}
              </p>
              {updater.releaseNotes && updater.availableVersion ? <details><summary>What’s new in {updater.availableVersion}</summary><p>{updater.releaseNotes}</p></details> : null}
              {updater.phase === "downloading" || updater.phase === "installing" ? (
                <div className="update-progress" role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateProgress}>
                  <i style={{ width: `${updateProgress ?? 8}%` }} />
                </div>
              ) : null}
              {updater.error ? <div className="update-error"><WarningCircle size={16} weight="fill" aria-hidden="true" /><span>{updater.error}</span></div> : null}
            </div>
            <div className="engine-actions update-actions">
              <button type="button" disabled={updateBusy || bridgeMode !== "native"} onClick={() => void checkForUpdates()}><ArrowClockwise className={updater.phase === "checking" ? "spin" : ""} size={17} aria-hidden="true" /> {updater.phase === "checking" ? "Checking…" : "Check now"}</button>
              {updater.availableVersion ? <button className="primary-action" type="button" disabled={updateBusy} onClick={() => void installUpdate()}><DownloadSimple size={17} weight="bold" aria-hidden="true" /> {updater.phase === "downloading" ? "Downloading…" : updater.phase === "installing" ? "Installing…" : `Install ${updater.availableVersion}`}</button> : null}
            </div>
          </section>

          <section className="settings-section engine-section" aria-labelledby="engine-settings">
            <header><div><span className="eyebrow">Verified engine</span><h2 id="engine-settings">{engine.ready ? "Ready" : "Needs attention"}</h2></div>{engine.ready ? <Check className="status-good" size={22} weight="bold" aria-hidden="true" /> : <WarningCircle className="status-warning" size={22} weight="fill" aria-hidden="true" />}</header>
            <div className="dependency-list">
              {engine.dependencies.length ? engine.dependencies.map((dependency) => (
                <div key={dependency.name}>
                  <span className={dependency.available ? "is-ready" : ""} aria-hidden="true" />
                  <strong>{dependency.name}</strong>
                  <small title={dependency.version ?? dependency.error}>{dependency.version?.split(/\s+/)[0] ?? dependency.error ?? "Unavailable"}</small>
                </div>
              )) : <p>Engine details are not available yet.</p>}
            </div>
            <div className="engine-actions">
              {!engine.ready ? <button className="primary-action" type="button" onClick={() => void prepareEngine()}><HardDrives size={17} aria-hidden="true" /> Set up engine</button> : null}
              <button type="button" onClick={() => void refreshDiagnostics()}><ArrowClockwise size={17} aria-hidden="true" /> Verify again</button>
            </div>
          </section>

          <section className="settings-section diagnostics-section" aria-labelledby="diagnostics-settings">
            <header><div><span className="eyebrow">Support</span><h2 id="diagnostics-settings">Diagnostics</h2></div><Bug size={21} aria-hidden="true" /></header>
            <dl>
              <div><dt>Sonic</dt><dd>{state.diagnostics.appVersion}</dd></div>
              <div><dt>System</dt><dd>{state.diagnostics.operatingSystem}{state.diagnostics.architecture ? ` · ${state.diagnostics.architecture}` : ""}</dd></div>
              <div><dt>Database</dt><dd>{state.diagnostics.databaseHealthy === false ? "Needs attention" : "Healthy"}</dd></div>
              <div><dt>Library</dt><dd>{state.diagnostics.libraryCount ?? state.library.length} items</dd></div>
              <div><dt>Mode</dt><dd>{bridgeMode === "native" ? "Installed desktop" : "Browser preview"}</dd></div>
              {state.diagnostics.webviewVersion ? <div><dt>WebView</dt><dd>{state.diagnostics.webviewVersion}</dd></div> : null}
              {state.diagnostics.databaseFile ? <div><dt>Data file</dt><dd title={state.diagnostics.databaseFile}>{shortPath(state.diagnostics.databaseFile, 30)}</dd></div> : null}
              {state.diagnostics.mediaEngineDirectory ? <div><dt>Engine path</dt><dd title={state.diagnostics.mediaEngineDirectory}>{shortPath(state.diagnostics.mediaEngineDirectory, 30)}</dd></div> : null}
            </dl>
            {state.diagnostics.recoveryWarnings?.length ? <div className="inline-alert"><WarningCircle size={17} weight="fill" aria-hidden="true" /><ul>{state.diagnostics.recoveryWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
            <button type="button" onClick={() => void exportDiagnostics()}><Bug size={17} aria-hidden="true" /> Export redacted report</button>
          </section>
        </aside>
      </div>
    </main>
  );
}
