import { useEffect, useMemo } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  Check,
  CircleNotch,
  DownloadSimple,
  FileAudio,
  FloppyDisk,
  FolderOpen,
  Info,
  Play,
  Stop,
  Waveform,
} from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatBytes, formatDuration, shortPath, statusLabel } from "../../domain/format";

const ACTIVE_STATES = ["preparing", "acquiring", "copying", "transcoding", "tagging", "validating", "publishing"];
const TEMPLATE_TOKENS = ["{title}", "{producer}", "{bpm}", "{key}", "{camelot}", "{detune}", "{preset}", "{source}", "{date}"];

function metadataSummary(metadata: { bpm?: number; key?: string; detuneCents?: number }) {
  const values = [
    metadata.bpm ? `${metadata.bpm} BPM` : null,
    metadata.key ?? null,
    metadata.detuneCents ? `${metadata.detuneCents > 0 ? "+" : ""}${metadata.detuneCents}c` : null,
  ].filter(Boolean);
  return values.length ? values.join(" · ") : "No musical tags found";
}

export function SourceInspector() {
  const {
    state,
    selectedJob: item,
    updateItem,
    updateMetadata,
    refreshFilename,
    enqueueItem,
    saveQueuedItem,
    cancelItem,
    retryItem,
    revealPath,
    openSource,
    chooseOutputDirectory,
    loadPreview,
  } = useSonic();

  const refreshKey = item
    ? `${item.id}|${item.metadata.title}|${item.metadata.artist}|${item.metadata.bpm}|${item.metadata.key}|${item.metadata.detuneCents}|${item.presetId}|${item.customTemplate}`
    : "";
  useEffect(() => {
    if (!item?.inspection || !["review", "queued"].includes(item.status)) return;
    const timer = window.setTimeout(() => void refreshFilename(item.id), 220);
    return () => window.clearTimeout(timer);
  }, [item?.id, item?.inspection, item?.status, refreshFilename, refreshKey]);

  const warnings = useMemo(() => item?.inspection
    ? [...new Set([...item.inspection.warnings, ...item.inspection.suggestedMetadata.warnings])]
    : [], [item?.inspection]);

  if (!item) {
    return (
      <aside className="inspector-panel inspector-empty" aria-label="Source inspector">
        <Waveform size={32} aria-hidden="true" />
        <h2>Select a source</h2>
        <p>Choose a session item to verify its musical details, naming, and export preset.</p>
      </aside>
    );
  }

  const inspection = item.inspection;
  const locked = ACTIVE_STATES.includes(item.status) || ["completed", "inspecting"].includes(item.status);
  const selectedPreset = state.presets.find((preset) => preset.id === item.presetId) ?? state.presets[0];
  const originalOutput = item.presetId === "original";
  const previewAvailable = item.source.kind === "localFile";
  const confidence = inspection ? Math.round(inspection.suggestedMetadata.confidence * 100) : 0;
  const customTemplate = item.customTemplate ?? state.settings.filenameTemplate;

  return (
    <aside className="inspector-panel" aria-labelledby="inspector-title">
      <div className="inspector-scroll">
        <header className="inspector-source">
          <div className="inspector-art" aria-hidden="true">
            {inspection?.thumbnailUrl ? <img src={inspection.thumbnailUrl} alt="" /> : <FileAudio size={25} />}
          </div>
          <div>
            <span>{inspection?.sourceLabel ?? (item.source.kind === "youtube" ? "YouTube" : "Local file")}</span>
            <h2 id="inspector-title">{inspection?.title ?? "Inspecting source"}</h2>
            <p>{inspection?.creator ?? "Creator not declared"}</p>
          </div>
          <span className={`state-chip state-${item.status}`}>{statusLabel(item.status)}</span>
        </header>

        {inspection ? (
          <div className="source-facts" aria-label="Source properties">
            <span>{formatDuration(inspection.durationSeconds)}</span>
            {inspection.codec ? <span>{inspection.codec}</span> : null}
            {inspection.audio.sampleRateHz ? <span>{Math.round(inspection.audio.sampleRateHz / 100) / 10} kHz</span> : null}
            {inspection.fileSizeBytes ? <span>{formatBytes(inspection.fileSizeBytes)}</span> : null}
            <span>{confidence}% suggested confidence</span>
          </div>
        ) : null}

        {item.status === "inspecting" ? (
          <div className="inspector-loading" role="status">
            <CircleNotch className="spin" size={19} aria-hidden="true" />
            <div><strong>Reading this source</strong><span>Tags, title, description, codec, and duration are being inspected.</span></div>
          </div>
        ) : null}

        {item.error ? (
          <div className="inline-alert is-error" role="alert">
            <Info size={17} weight="fill" aria-hidden="true" />
            <div><strong>{item.errorCode ?? "Sonic needs attention"}</strong><span>{item.error}</span></div>
          </div>
        ) : null}

        {inspection ? (
          <>
            <section className="inspector-section" aria-labelledby="metadata-heading">
              <div className="section-title-row">
                <div><span className="eyebrow">Final metadata</span><h3 id="metadata-heading">Musical identity</h3></div>
                <button
                  className="reset-metadata"
                  type="button"
                  disabled={locked}
                  onClick={() => updateMetadata(item.id, {
                    title: inspection.title,
                    artist: inspection.creator,
                    bpm: inspection.suggestedMetadata.bpm?.toString() ?? "",
                    key: inspection.suggestedMetadata.key ?? "",
                    detuneCents: inspection.suggestedMetadata.detuneCents?.toString() ?? "",
                    alternateBpms: inspection.suggestedMetadata.alternateBpms,
                    camelot: inspection.suggestedMetadata.camelot,
                    tuningHz: inspection.suggestedMetadata.tuningHz,
                  })}
                >Reset to suggested</button>
              </div>

              <div className="metadata-provenance" aria-label="Metadata source comparison">
                <div><span>Declared</span><strong>{metadataSummary(inspection.declaredMetadata)}</strong></div>
                <div><span>Embedded</span><strong>{metadataSummary(inspection.embeddedMetadata)}</strong></div>
                <div className="is-final"><span>Final</span><strong>{metadataSummary({ bpm: Number(item.metadata.bpm) || undefined, key: item.metadata.key || undefined, detuneCents: Number(item.metadata.detuneCents) || undefined })}</strong></div>
                <b>{confidence}% suggested confidence</b>
              </div>

              <div className="text-field-grid">
                <label className="field span-two">
                  <span>Title</span>
                  <input value={item.metadata.title ?? ""} disabled={locked} onChange={(event) => updateMetadata(item.id, { title: event.target.value })} />
                </label>
                <label className="field span-two">
                  <span>Artist / producer</span>
                  <input value={item.metadata.artist ?? ""} disabled={locked} onChange={(event) => updateMetadata(item.id, { artist: event.target.value })} placeholder="Not declared" />
                </label>
                <label className="field metric-field">
                  <span>Tempo</span>
                  <span className="input-with-unit">
                    <input type="number" min="20" max="400" step="0.1" value={item.metadata.bpm} disabled={locked} onChange={(event) => updateMetadata(item.id, { bpm: event.target.value })} aria-label="Final tempo in BPM" />
                    <b>BPM</b>
                  </span>
                </label>
                <label className="field metric-field">
                  <span>Key</span>
                  <span className="input-with-unit">
                    <input value={item.metadata.key} disabled={locked} onChange={(event) => updateMetadata(item.id, { key: event.target.value, camelot: "" })} aria-label="Final musical key" />
                    <b>{item.metadata.camelot ?? inspection.suggestedMetadata.camelot ?? "—"}</b>
                  </span>
                </label>
                <label className="field metric-field span-two">
                  <span>Detune</span>
                  <span className="input-with-unit">
                    <input type="number" min="-1200" max="1200" step="0.1" value={item.metadata.detuneCents} disabled={locked} onChange={(event) => updateMetadata(item.id, { detuneCents: event.target.value })} aria-label="Final detune in cents" />
                    <b>cents</b>
                  </span>
                </label>
              </div>

              {inspection.suggestedMetadata.alternateBpms.length ? (
                <div className="alternate-values">
                  <span>Tempo alternatives</span>
                  {inspection.suggestedMetadata.alternateBpms.map((bpm) => (
                    <button type="button" key={bpm} disabled={locked} onClick={() => updateMetadata(item.id, { bpm: bpm.toString() })}>{bpm} BPM</button>
                  ))}
                </div>
              ) : null}
              {item.metadata.bpm && Number.isFinite(Number(item.metadata.bpm)) ? (
                <div className="alternate-values">
                  <span>Tempo feel</span>
                  {Number(item.metadata.bpm) / 2 >= 20 ? <button type="button" disabled={locked} onClick={() => updateMetadata(item.id, { bpm: (Number(item.metadata.bpm) / 2).toString() })}>½ · {Number(item.metadata.bpm) / 2} BPM</button> : null}
                  {Number(item.metadata.bpm) * 2 <= 400 ? <button type="button" disabled={locked} onClick={() => updateMetadata(item.id, { bpm: (Number(item.metadata.bpm) * 2).toString() })}>2× · {Number(item.metadata.bpm) * 2} BPM</button> : null}
                </div>
              ) : null}

              {warnings.length ? (
                <div className="inline-alert" role="note">
                  <Info size={17} weight="fill" aria-hidden="true" />
                  <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </div>
              ) : null}

              <details className="evidence-disclosure">
                <summary>
                  <span><strong>Detection evidence</strong><small>{inspection.suggestedMetadata.matches.length} source matches</small></span>
                  <CaretDown size={16} aria-hidden="true" />
                </summary>
                <div className="evidence-table">
                  {inspection.suggestedMetadata.matches.length ? inspection.suggestedMetadata.matches.map((match, index) => (
                    <div key={`${match.kind}-${index}`}>
                      <span>{match.kind}</span>
                      <strong>{match.rawText}</strong>
                      <small>{match.source} · {Math.round(match.confidence * 100)}%</small>
                    </div>
                  )) : <p>No labelled metadata was found. Your final values remain editable.</p>}
                </div>
              </details>
            </section>

            <section className="inspector-section" aria-labelledby="output-heading">
              <div className="section-title-row">
                <div><span className="eyebrow">Output</span><h3 id="output-heading">Export recipe</h3></div>
                <span className="preset-badge">{selectedPreset?.badge}</span>
              </div>

              <label className="field">
                <span>Preset</span>
                <select value={item.presetId} disabled={locked} onChange={(event) => {
                  const presetId = event.target.value as typeof item.presetId;
                  updateItem(item.id, presetId === "original"
                    ? { presetId, channelMode: "preserve", normalizeLufs: undefined, writeEmbeddedTags: false }
                    : { presetId });
                }}>
                  {state.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
                <small>{selectedPreset?.description}</small>
              </label>

              <fieldset className="segmented-field" disabled={locked || originalOutput}>
                <legend>Channels</legend>
                {(["preserve", "stereo", "mono"] as const).map((mode) => (
                  <label key={mode} className={item.channelMode === mode ? "is-selected" : ""}>
                    <input type="radio" name={`channels-${item.id}`} checked={item.channelMode === mode} onChange={() => updateItem(item.id, { channelMode: mode })} />
                    <span>{mode[0].toUpperCase() + mode.slice(1)}</span>
                  </label>
                ))}
              </fieldset>

              <div className="option-grid">
                <label className="switch-field">
                  <input type="checkbox" checked={item.writeEmbeddedTags} disabled={locked || originalOutput || !selectedPreset?.supportsEmbeddedTags} onChange={(event) => updateItem(item.id, { writeEmbeddedTags: event.target.checked })} />
                  <span><b>Embed metadata</b><small>Write supported tags into the export</small></span>
                </label>
                <label className="field normalize-field">
                  <span>Normalize loudness <small>optional</small></span>
                  <span className="input-with-unit">
                    <input type="number" min="-24" max="-8" step="0.5" value={item.normalizeLufs ?? ""} disabled={locked || originalOutput} onChange={(event) => updateItem(item.id, { normalizeLufs: event.target.value ? Number(event.target.value) : undefined })} placeholder="Off" />
                    <b>LUFS</b>
                  </span>
                </label>
              </div>

              <label className="field">
                <span>Filename template</span>
                <select
                  value={state.settings.templates.some((template) => template.id === item.templateId) ? item.templateId : "custom"}
                  disabled={locked}
                  onChange={(event) => {
                    const template = state.settings.templates.find((candidate) => candidate.id === event.target.value);
                    if (template) updateItem(item.id, { templateId: template.id, customTemplate: template.template });
                  }}
                >
                  {state.settings.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  <option value="custom">Custom</option>
                </select>
                <textarea value={customTemplate} disabled={locked} rows={2} onChange={(event) => updateItem(item.id, { templateId: "custom", customTemplate: event.target.value })} aria-label="Filename template" />
              </label>
              <div className="template-tokens" aria-label="Filename template tokens">
                {TEMPLATE_TOKENS.map((token) => (
                  <button type="button" key={token} disabled={locked} onClick={() => updateItem(item.id, { templateId: "custom", customTemplate: `${customTemplate}${customTemplate.endsWith(" ") ? "" : " "}${token}` })}>{token}</button>
                ))}
              </div>
              <div className="filename-preview">
                <span>Filename preview</span>
                <strong>{item.filenamePreview || "Sonic is preparing the filename…"}</strong>
              </div>

              <button className="path-button" type="button" disabled={locked} onClick={() => void chooseOutputDirectory(item.id)}>
                <FolderOpen size={17} aria-hidden="true" />
                <span><small>Destination</small><strong>{item.outputDirectory ? shortPath(item.outputDirectory, 56) : "Choose a folder"}</strong></span>
                <CaretDown size={14} aria-hidden="true" />
              </button>
            </section>

            <section className="inspector-section source-actions" aria-label="Source actions">
              <button
                type="button"
                disabled={!previewAvailable}
                title={previewAvailable ? "Load a validated local preview" : "YouTube previews become available from the Library after export"}
                onClick={() => void loadPreview(item)}
              >
                <Play size={17} weight="fill" aria-hidden="true" />
                {previewAvailable ? "Load preview" : "Preview after export"}
              </button>
              <button type="button" onClick={() => void openSource(item.source)}><ArrowSquareOut size={17} aria-hidden="true" /> Open source</button>
              {!previewAvailable ? <small className="preview-help">Remote previews are available from Library after export.</small> : null}
            </section>
          </>
        ) : null}
      </div>

      <footer className="inspector-action">
        <div>
          <span>{statusLabel(item.status)}</span>
          <strong>{item.progress.message ?? selectedPreset?.name ?? "Review export"}</strong>
        </div>
        {item.status === "review" ? (
          <button className="primary-action" type="button" onClick={() => void enqueueItem(item.id)} disabled={!item.outputDirectory || inspection?.isLive}>
            <DownloadSimple size={19} weight="bold" aria-hidden="true" /> Queue export
          </button>
        ) : item.status === "queued" ? (
          <button className="primary-action" type="button" onClick={() => void saveQueuedItem(item.id)}>
            <FloppyDisk size={18} weight="bold" aria-hidden="true" /> Save queue changes
          </button>
        ) : ACTIVE_STATES.includes(item.status) ? (
          <button className="danger-action" type="button" onClick={() => void cancelItem(item.id)}>
            <Stop size={16} weight="fill" aria-hidden="true" /> Cancel export
          </button>
        ) : item.status === "completed" && item.outputPath ? (
          <button className="primary-action" type="button" onClick={() => void revealPath(item.outputPath ?? "")}>
            <Check size={18} weight="bold" aria-hidden="true" /> Show in folder
          </button>
        ) : ["failed", "cancelled", "interrupted"].includes(item.status) ? (
          <button className="primary-action" type="button" onClick={() => void retryItem(item.id)}>
            <ArrowClockwise size={18} weight="bold" aria-hidden="true" /> Retry
          </button>
        ) : null}
      </footer>
    </aside>
  );
}
