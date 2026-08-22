import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  Bug,
  Check,
  DownloadSimple,
  FolderOpen,
  HardDrives,
  LinkBreak,
  Plus,
  Trash,
  WarningCircle,
  Waveform,
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
    prepareStemEngine,
    stemEngine,
    updater,
    checkForUpdates,
    installUpdate,
    createLibraryRoot,
    updateLibraryRoot,
    deleteLibraryRoot,
  } = useSonic();
  const [draft, setDraft] = useState<SonicSettings>(state.settings);
  const [saving, setSaving] = useState(false);
  const [rootLabel, setRootLabel] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [relinkingId, setRelinkingId] = useState<string | null>(null);
  const [relinkPath, setRelinkPath] = useState("");

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
                ? "Couldn’t check for updates"
                : "Automatic updates";

  return (
    <main className="settings-page" aria-labelledby="settings-heading">
      <header className="page-heading settings-heading">
        <div><span className="eyebrow">Settings</span><h1 id="settings-heading">Files and exports</h1><p>Choose where files go and how they’re saved.</p></div>
        <button className="primary-action save-settings" type="button" disabled={saving} onClick={() => void save()}><Check size={18} weight="bold" aria-hidden="true" />{saving ? "Saving…" : "Save changes"}</button>
      </header>

      <div className="settings-columns">
        <div className="settings-main">
          <section className="settings-section" aria-labelledby="general-settings">
            <header><div><span className="eyebrow">General</span><h2 id="general-settings">Export defaults</h2></div><FolderOpen size={21} aria-hidden="true" /></header>
            <button className="path-button" type="button" onClick={() => void chooseOutputDirectory(undefined, draft)}>
              <FolderOpen size={17} aria-hidden="true" />
              <span><small>Default output folder</small><strong>{draft.defaultOutputDirectory ? shortPath(draft.defaultOutputDirectory, 68) : "Choose a folder"}</strong></span>
            </button>
            <div className="settings-field-grid">
              <label className="field"><span>Default export preset</span><select value={draft.defaultPresetId} onChange={(event) => update("defaultPresetId", event.target.value as SonicSettings["defaultPresetId"])}>{state.presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>
              <label className="field"><span>Simultaneous exports</span><select value={draft.maxConcurrentJobs} onChange={(event) => update("maxConcurrentJobs", Number(event.target.value))}><option value={1}>1 (lightest)</option><option value={2}>2</option><option value={3}>3</option></select></label>
            </div>
            <div className="settings-switches">
              <label className="switch-field"><input type="checkbox" checked={draft.historyEnabled} onChange={(event) => update("historyEnabled", event.target.checked)} /><span><b>Save exports to Library</b><small>Keep a searchable record of finished tracks</small></span></label>
              <label className="switch-field"><input type="checkbox" checked={draft.writeEmbeddedTags} onChange={(event) => update("writeEmbeddedTags", event.target.checked)} /><span><b>Embed metadata</b><small>Save title, artist, BPM, and key in supported files</small></span></label>
              <label className="switch-field"><input type="checkbox" checked={draft.includeSourcePathInSidecar} onChange={(event) => update("includeSourcePathInSidecar", event.target.checked)} /><span><b>Save the original file path</b><small>May reveal folder names in metadata</small></span></label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="naming-settings">
            <header><div><span className="eyebrow">Naming</span><h2 id="naming-settings">File names</h2></div><HardDrives size={21} aria-hidden="true" /></header>
            <label className="field"><span>Default template</span><textarea rows={3} value={draft.filenameTemplate} onChange={(event) => update("filenameTemplate", event.target.value)} /></label>
            <div className="template-presets">
              {draft.templates.map((template) => <button type="button" key={template.id} className={draft.filenameTemplate === template.template ? "is-selected" : ""} onClick={() => { update("filenameTemplate", template.template); update("defaultTemplateId", template.id); }}><strong>{template.name}</strong><small>{template.template}</small></button>)}
            </div>
            <p className="settings-note">Available tokens: <code>{"{title}"}</code> <code>{"{producer}"}</code> <code>{"{bpm}"}</code> <code>{"{key}"}</code> <code>{"{camelot}"}</code> <code>{"{detune}"}</code> <code>{"{preset}"}</code> <code>{"{source}"}</code> <code>{"{date}"}</code></p>
          </section>

          <section className="settings-section" aria-labelledby="library-storage-settings">
            <header><div><span className="eyebrow">Library</span><h2 id="library-storage-settings">Library locations</h2></div><HardDrives size={21} aria-hidden="true" /></header>
            {state.libraryRoots.length ? (
              <ul className="roots-list">
                {state.libraryRoots.map((root) => (
                  <li key={root.id}>
                    <div className="root-row">
                      <span className="root-label"><strong>{root.label}</strong><small title={root.rootPath}>{shortPath(root.rootPath, 44)}</small></span>
                      <span className="root-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setRelinkingId(relinkingId === root.id ? null : root.id);
                            setRelinkPath(root.rootPath);
                          }}
                          aria-expanded={relinkingId === root.id}
                        >
                          <LinkBreak size={14} aria-hidden="true" /> Relink
                        </button>
                        <button type="button" onClick={() => {
                          if (window.confirm(`Forget the “${root.label}” location? Library records are kept.`)) void deleteLibraryRoot(root.id);
                        }} aria-label={`Remove location ${root.label}`}>
                          <Trash size={14} aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                    {relinkingId === root.id ? (
                      <div className="relink-form">
                        <label className="field">
                          <span>Moved to a new drive letter or folder?</span>
                          <input value={relinkPath} onChange={(event) => setRelinkPath(event.target.value)} aria-label={`New path for ${root.label}`} />
                        </label>
                        <button className="primary-action" type="button" disabled={!relinkPath.trim()} onClick={() => {
                          void updateLibraryRoot(root.id, { rootPath: relinkPath.trim() });
                          setRelinkingId(null);
                        }}>Save new location</button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settings-note">Exports live where you save them. Add a library location to keep drives relinkable if letters change.</p>
            )}
            <form className="root-create" onSubmit={(event) => {
              event.preventDefault();
              if (!rootLabel.trim() || !rootPath.trim()) return;
              void createLibraryRoot(rootLabel.trim(), rootPath.trim());
              setRootLabel("");
              setRootPath("");
            }}>
              <label className="field"><span>Name</span><input value={rootLabel} onChange={(event) => setRootLabel(event.target.value)} placeholder="Main beat drive" aria-label="Library location name" /></label>
              <label className="field"><span>Folder</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="D:\Beats" aria-label="Library location folder path" /></label>
              <button type="submit" disabled={!rootLabel.trim() || !rootPath.trim()}><Plus size={15} weight="bold" aria-hidden="true" /> Add location</button>
            </form>
          </section>

          <section className="settings-section" aria-labelledby="safety-settings">
            <header><div><span className="eyebrow">Limits</span><h2 id="safety-settings">Source limits</h2></div><Check size={21} aria-hidden="true" /></header>
            <div className="settings-field-grid">
              <label className="field"><span>Maximum duration</span><span className="input-with-unit"><input type="number" min="1" max="360" value={draft.maxDurationMinutes} onChange={(event) => update("maxDurationMinutes", Number(event.target.value))} /><b>minutes</b></span></label>
              <label className="field"><span>Maximum input size</span><span className="input-with-unit"><input type="number" min="1" max="20" step="0.5" value={Math.round(draft.maxInputBytes / 107_374_182.4) / 10} onChange={(event) => update("maxInputBytes", Math.round(Number(event.target.value) * 1024 ** 3))} /><b>GB</b></span></label>
            </div>
            <p className="settings-note">Tracks over these limits are skipped. Current size limit: {formatBytes(draft.maxInputBytes)}.</p>
          </section>
        </div>

        <aside className="settings-side">
          <section className={`settings-section update-section is-${updater.phase}`} aria-labelledby="update-settings">
            <header>
              <div><span className="eyebrow">Software update</span><h2 id="update-settings">{updateHeading}</h2></div>
              {updater.phase === "upToDate" ? <Check className="status-good" size={22} weight="bold" aria-hidden="true" /> : <DownloadSimple className={updater.phase === "error" ? "status-warning" : "update-icon"} size={22} weight="bold" aria-hidden="true" />}
            </header>
            <div className="update-copy">
              <p>
                {updater.phase === "available" || (updater.phase === "error" && updater.availableVersion)
                  ? `${updater.availableVersion} is ready. Its signature is valid.`
                  : updater.phase === "downloading"
                    ? `Downloaded ${formatBytes(updater.downloadedBytes)}${updater.totalBytes ? ` of ${formatBytes(updater.totalBytes)}` : ""}.`
                    : updater.phase === "installing"
                      ? "Sonic restarts after the update."
                      : updater.phase === "upToDate"
                        ? `You’re using the latest version: ${state.diagnostics.appVersion}.`
                        : updater.phase === "unavailable"
                          ? "Update checks are only available in the installed app."
                          : updater.phase === "checking"
                            ? "Checking GitHub for a signed update…"
                            : "Sonic checks after startup. You decide when to install."}
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
            <header><div><span className="eyebrow">Media tools</span><h2 id="engine-settings">{engine.ready ? "Ready" : "Setup needed"}</h2></div>{engine.ready ? <Check className="status-good" size={22} weight="bold" aria-hidden="true" /> : <WarningCircle className="status-warning" size={22} weight="fill" aria-hidden="true" />}</header>
            <div className="dependency-list">
              {engine.dependencies.length ? engine.dependencies.map((dependency) => (
                <div key={dependency.name}>
                  <span className={dependency.available ? "is-ready" : ""} aria-hidden="true" />
                  <strong>{dependency.name}</strong>
                  <small title={dependency.version ?? dependency.error}>{dependency.version?.split(/\s+/)[0] ?? dependency.error ?? "Unavailable"}</small>
                </div>
              )) : <p>No tool details available.</p>}
            </div>
            <div className="engine-actions">
              {!engine.ready ? <button className="primary-action" type="button" onClick={() => void prepareEngine()}><HardDrives size={17} aria-hidden="true" /> Set up media tools</button> : null}
              <button type="button" onClick={() => void refreshDiagnostics()}><ArrowClockwise size={17} aria-hidden="true" /> Check again</button>
            </div>
          </section>

          <section className="settings-section engine-section" aria-labelledby="stem-engine-settings">
            <header><div><span className="eyebrow">Stem splitter</span><h2 id="stem-engine-settings">{stemEngine?.installed ? "Ready" : "Setup needed"}</h2></div><Waveform size={22} aria-hidden="true" /></header>
            <p className="settings-note">{stemEngine?.description ?? "Split tracks into vocals, drums, bass, and other on this device."}</p>
            <div className="dependency-list"><div><span className={stemEngine?.installed ? "is-ready" : ""} aria-hidden="true" /><strong>{stemEngine?.model ?? "Demucs v4 htdemucs_ft"}</strong><small>{stemEngine?.installed ? "Installed" : "Not installed"}</small></div></div>
            {!stemEngine?.installed ? <div className="engine-actions"><button className="primary-action" type="button" onClick={() => void prepareStemEngine()}><DownloadSimple size={17} aria-hidden="true" /> Install stem splitter</button></div> : null}
            <p className="settings-note">Setup downloads a large engine. The model downloads the first time you split a track.</p>
          </section>

          <section className="settings-section diagnostics-section" aria-labelledby="diagnostics-settings">
            <header><div><span className="eyebrow">Help</span><h2 id="diagnostics-settings">Support</h2></div><Bug size={21} aria-hidden="true" /></header>
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
            <button type="button" onClick={() => void exportDiagnostics()}><Bug size={17} aria-hidden="true" /> Save support report</button>
            <button type="button" onClick={() => window.dispatchEvent(new Event("sonic:replay-tutorial"))}><Bug size={17} aria-hidden="true" /> Replay tutorial</button>
          </section>
        </aside>
      </div>
    </main>
  );
}
