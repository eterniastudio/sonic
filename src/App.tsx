import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CaretDown,
  Check,
  CircleNotch,
  ClipboardText,
  DownloadSimple,
  FolderOpen,
  Info,
  LinkSimple,
  Stop,
  Waveform,
  X,
  YoutubeLogo,
} from "@phosphor-icons/react";
import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-700.css";
import "./App.css";

type Dependency = {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
};

type DependencyStatus = {
  ready: boolean;
  dependencies: Dependency[];
};

type MetadataMatch = {
  kind: string;
  displayValue: string;
  rawText: string;
  source: string;
  confidence: number;
};

type MusicMetadata = {
  bpm?: number;
  alternateBpms: number[];
  key?: string;
  camelot?: string;
  detuneCents?: number;
  tuningHz?: number;
  confidence: number;
  matches: MetadataMatch[];
  warnings: string[];
};

type VideoInfo = {
  id: string;
  title: string;
  description: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  uploader?: string;
  webpageUrl: string;
  isLive: boolean;
  metadata: MusicMetadata;
};

type DownloadProgress = {
  jobId: string;
  status: "queued" | "downloading" | "converting" | "completed" | "failed" | "cancelled";
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  outputPath?: string;
  message?: string;
  error?: string;
};

type DownloadStarted = { jobId: string };
type AudioFormat = "original" | "wav" | "mp3" | "m4a";

const FORMATS: Array<{ id: AudioFormat; label: string; detail: string; badge: string }> = [
  { id: "original", label: "Original", detail: "No conversion", badge: "Source quality" },
  { id: "wav", label: "WAV", detail: "Ready for any DAW", badge: "Studio workflow" },
  { id: "mp3", label: "MP3", detail: "Small and universal", badge: "320 kbps" },
  { id: "m4a", label: "M4A", detail: "Compact high quality", badge: "AAC audio" },
];

const PENDING_JOB_ID = "__sonic_pending__";
const PREVIEW_JOB_ID = "sonic-preview-job";

const DEMO_VIDEO: VideoInfo = {
  id: "sonic-demo",
  title: "Night Shift - Industrial Type Beat",
  description: "BPM: 144\nKEY: F# minor\nTuning: A=432Hz",
  thumbnailUrl: "https://i.ytimg.com/vi/BaW_jenozKc/hqdefault.jpg",
  durationSeconds: 173,
  uploader: "Late Night Audio",
  webpageUrl: "https://www.youtube.com/watch?v=BaW_jenozKc",
  isLive: false,
  metadata: {
    bpm: 144,
    alternateBpms: [72],
    key: "F# minor",
    camelot: "11A",
    detuneCents: -31.8,
    tuningHz: 432,
    confidence: 0.98,
    matches: [
      { kind: "bpm", displayValue: "144 BPM", rawText: "BPM: 144", source: "description", confidence: 0.98 },
      { kind: "key", displayValue: "F# minor", rawText: "KEY: F# minor", source: "description", confidence: 0.98 },
      { kind: "tuning", displayValue: "A=432 Hz (-31.8c)", rawText: "Tuning: A=432Hz", source: "description", confidence: 0.98 },
    ],
    warnings: [],
  },
};

function formatDuration(seconds?: number) {
  if (seconds === undefined) return "--:--";
  const minutes = Math.floor(seconds / 60);
  return minutes + ":" + Math.floor(seconds % 60).toString().padStart(2, "0");
}

function formatBytes(bytes?: number) {
  if (!bytes || bytes < 1) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0) + " " + units[power];
}

function formatSpeed(bytes?: number) {
  return bytes ? formatBytes(bytes) + "/s" : "—";
}

function formatEta(seconds?: number) {
  if (seconds === undefined) return "—";
  return seconds >= 60 ? Math.floor(seconds / 60) + "m " + (seconds % 60) + "s" : seconds + "s";
}

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Sonic hit an unexpected error.";
}

function safeBaseName(value: string) {
  return value
    .replace(/[<>:"/\\|?*%]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 115);
}

function metadataFileName(video: VideoInfo, bpm: string, key: string, detune: string) {
  const parts = [safeBaseName(video.title) || "Sonic " + video.id];
  const bpmValue = Number(bpm);
  const detuneValue = Number(detune);
  if (Number.isFinite(bpmValue) && bpm.trim()) parts.push(bpmValue + " BPM");
  if (key.trim()) parts.push(key.trim());
  if (Number.isFinite(detuneValue) && detune.trim() && Math.abs(detuneValue) >= 0.05) {
    parts.push((detuneValue > 0 ? "+" : "") + detuneValue + "c");
  }
  return safeBaseName(parts.join(" — "));
}

function parseOptionalRange(value: string, label: string, minimum: number, maximum: number) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(label + " must be between " + minimum + " and " + maximum + ".");
  }
  return parsed;
}

function App() {
  const native = isTauri();
  const [dependencies, setDependencies] = useState<DependencyStatus | null>(null);
  const [url, setUrl] = useState("");
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [format, setFormat] = useState<AudioFormat>("wav");
  const [bpm, setBpm] = useState("");
  const [musicalKey, setMusicalKey] = useState("");
  const [detune, setDetune] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileNameIsCustom, setFileNameIsCustom] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "inspecting" | "ready" | "downloading" | "complete">("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [completedPath, setCompletedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const hydrateVideo = useCallback((info: VideoInfo) => {
    const nextBpm = info.metadata.bpm?.toString() ?? "";
    const nextKey = info.metadata.key ?? "";
    const nextDetune = info.metadata.detuneCents !== undefined
      ? (Math.round(info.metadata.detuneCents * 10) / 10).toString()
      : "";
    setVideo(info);
    setBpm(nextBpm);
    setMusicalKey(nextKey);
    setDetune(nextDetune);
    setFileName(metadataFileName(info, nextBpm, nextKey, nextDetune));
    setFileNameIsCustom(false);
    setEvidenceOpen(false);
    setPhase("ready");
    setCompletedPath(null);
    window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
  }, []);

  const refreshDependencies = useCallback(async () => {
    setError(null);
    if (!native) {
      setDependencies({
        ready: true,
        dependencies: ["yt-dlp", "ffmpeg", "ffprobe", "deno"].map((name) => ({
          name,
          available: true,
          version: "preview",
        })),
      });
      setOutputDirectory("C:\\Users\\Producer\\Downloads\\Sonic");
      return;
    }
    try {
      const [status, directory] = await Promise.all([
        invoke<DependencyStatus>("check_dependencies"),
        invoke<string>("get_default_output_dir"),
      ]);
      setDependencies(status);
      setOutputDirectory(directory);
    } catch (caught) {
      setError(errorText(caught));
      setDependencies({ ready: false, dependencies: [] });
    }
  }, [native]);

  useEffect(() => {
    void refreshDependencies();
  }, [refreshDependencies]);

  useEffect(() => {
    if (!video || fileNameIsCustom) return;
    setFileName(metadataFileName(video, bpm, musicalKey, detune));
  }, [video, bpm, musicalKey, detune, fileNameIsCustom]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<DownloadProgress>("sonic://download-progress", ({ payload }) => {
      if (activeJobRef.current === PENDING_JOB_ID) {
        activeJobRef.current = payload.jobId;
        setActiveJobId(payload.jobId);
      } else if (payload.jobId !== activeJobRef.current) {
        return;
      }

      setProgress(payload);
      if (payload.status === "completed") {
        setActiveJobId(null);
        activeJobRef.current = null;
        setCompletedPath(payload.outputPath ?? null);
        setPhase("complete");
      } else if (payload.status === "failed") {
        setActiveJobId(null);
        activeJobRef.current = null;
        setPhase("ready");
        setError(payload.error ?? "The download failed.");
      } else if (payload.status === "cancelled") {
        setActiveJobId(null);
        activeJobRef.current = null;
        setPhase("ready");
        setProgress(null);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [native]);

  useEffect(() => {
    return () => {
      if (previewTimerRef.current !== null) {
        window.clearInterval(previewTimerRef.current);
      }
    };
  }, []);

  const inspect = async () => {
    const value = url.trim();
    if (!value) {
      setError("Paste a YouTube video URL first.");
      return;
    }
    if (dependencies?.ready !== true) {
      setError("Sonic's local engine is not ready yet.");
      return;
    }

    setError(null);
    setVideo(null);
    setProgress(null);
    setCompletedPath(null);
    setPhase("inspecting");
    try {
      if (!native) {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        hydrateVideo({ ...DEMO_VIDEO, webpageUrl: value });
      } else {
        hydrateVideo(await invoke<VideoInfo>("inspect_video", { url: value }));
      }
    } catch (caught) {
      setPhase("idle");
      setError(errorText(caught));
    }
  };

  const paste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (value) setUrl(value.trim());
    } catch {
      setError("Clipboard access was blocked. Paste the link with Ctrl+V.");
    }
  };

  const chooseDirectory = async () => {
    if (!native) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: outputDirectory,
      });
      if (typeof selected === "string") setOutputDirectory(selected);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const openSource = async () => {
    if (!video) return;
    try {
      if (native) await openUrl(video.webpageUrl);
      else window.open(video.webpageUrl, "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const revealCompletedFile = async () => {
    if (!completedPath || !native) return;
    try {
      await revealItemInDir(completedPath);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const startDownload = async () => {
    if (!video || !outputDirectory) return;
    if (video.isLive) {
      setError("Live videos cannot be downloaded. Try again after the stream has ended.");
      return;
    }

    let bpmNumber: number | undefined;
    let detuneNumber: number | undefined;
    try {
      bpmNumber = parseOptionalRange(bpm, "BPM", 30, 320);
      detuneNumber = parseOptionalRange(detune, "Detune", -1200, 1200);
    } catch (caught) {
      setError(errorText(caught));
      return;
    }

    setError(null);
    setCompletedPath(null);
    setProgress({ jobId: PENDING_JOB_ID, status: "queued", percent: 0, message: "Preparing download" });
    setPhase("downloading");

    try {
      if (!native) {
        setActiveJobId(PREVIEW_JOB_ID);
        activeJobRef.current = PREVIEW_JOB_ID;
        let nextPercent = 0;
        previewTimerRef.current = window.setInterval(() => {
          nextPercent += 5;
          const status = nextPercent >= 90 ? "converting" : "downloading";
          setProgress({
            jobId: PREVIEW_JOB_ID,
            status,
            percent: Math.min(nextPercent, 100),
            downloadedBytes: Math.round(41_000_000 * Math.min(nextPercent, 100) / 100),
            totalBytes: 41_000_000,
            speedBytesPerSecond: 4_800_000,
            etaSeconds: Math.max(0, Math.round((100 - nextPercent) / 10)),
            message: status === "converting" ? "Preparing " + format.toUpperCase() : "Downloading audio",
          });
          if (nextPercent >= 100) {
            if (previewTimerRef.current !== null) window.clearInterval(previewTimerRef.current);
            previewTimerRef.current = null;
            setActiveJobId(null);
            activeJobRef.current = null;
            const previewExtension = format === "original" ? "m4a" : format;
            setCompletedPath(outputDirectory + "\\" + fileName + "." + previewExtension);
            setPhase("complete");
          }
        }, 350);
        return;
      }

      activeJobRef.current = PENDING_JOB_ID;
      setActiveJobId(null);
      const result = await invoke<DownloadStarted>("start_download", {
        request: {
          url: video.webpageUrl,
          outputDirectory,
          format,
          fileName: fileName.trim() || undefined,
          bpm: bpmNumber,
          key: musicalKey.trim() || undefined,
          detuneCents: detuneNumber,
        },
      });

      if (activeJobRef.current === PENDING_JOB_ID || activeJobRef.current === result.jobId) {
        activeJobRef.current = result.jobId;
        setActiveJobId(result.jobId);
        setProgress({ jobId: result.jobId, status: "queued", percent: 0, message: "Download queued" });
      }
    } catch (caught) {
      activeJobRef.current = null;
      setActiveJobId(null);
      setPhase("ready");
      setProgress(null);
      setError(errorText(caught));
    }
  };

  const cancel = async () => {
    if (!activeJobId) return;
    try {
      if (!native) {
        if (previewTimerRef.current !== null) window.clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
      } else {
        const cancelled = await invoke<boolean>("cancel_download", { jobId: activeJobId });
        if (!cancelled) {
          setError("The download could not be cancelled because it has already finished.");
          return;
        }
      }
      activeJobRef.current = null;
      setActiveJobId(null);
      setPhase("ready");
      setProgress(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const syncFileName = () => {
    if (!video) return;
    setFileName(metadataFileName(video, bpm, musicalKey, detune));
    setFileNameIsCustom(false);
  };

  const renderUrlEntry = (compact: boolean) => {
    const busy = phase === "inspecting";
    const locked = busy || phase === "downloading";
    return (
      <form
        className={"url-entry" + (compact ? " is-compact" : "") + (busy ? " is-busy" : "")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked) void inspect();
        }}
      >
        <LinkSimple size={compact ? 16 : 19} weight="bold" aria-hidden="true" />
        <label className="sr-only" htmlFor={compact ? "video-url-compact" : "video-url"}>
          YouTube video URL
        </label>
        <input
          id={compact ? "video-url-compact" : "video-url"}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Paste a YouTube link"
          autoComplete="off"
          spellCheck={false}
          disabled={locked}
        />
        <button
          className="paste-action"
          type="button"
          onClick={() => void paste()}
          disabled={locked}
          aria-label="Paste from clipboard"
          title="Paste from clipboard"
        >
          <ClipboardText size={18} aria-hidden="true" />
        </button>
        <button
          className="analyze-action"
          type="submit"
          disabled={locked || dependencies?.ready !== true}
        >
          {busy ? <CircleNotch className="spin" size={18} aria-hidden="true" /> : null}
          <span>{compact ? "Analyze" : busy ? "Reading video" : "Continue"}</span>
          {!busy && !compact ? <ArrowRight size={18} weight="bold" aria-hidden="true" /> : null}
        </button>
      </form>
    );
  };

  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const availableDependencies = dependencies?.dependencies.filter((item) => item.available).length ?? 0;
  const dependencyTotal = dependencies?.dependencies.length ?? 0;
  const engineReady = dependencies?.ready === true;
  const selectedFormat = FORMATS.find((item) => item.id === format) ?? FORMATS[1];
  const confidence = video ? Math.round(video.metadata.confidence * 100) : 0;
  const busy = phase === "inspecting" || phase === "downloading";

  return (
    <div className="app-shell" aria-busy={busy}>
      <header className="app-header">
        <div className="brand">
          <Waveform size={21} weight="bold" aria-hidden="true" />
          <span>SONIC</span>
        </div>

        <div className="header-import">{renderUrlEntry(true)}</div>

        <div className="engine-state" role="status" aria-live="polite">
          <span className={"engine-dot" + (engineReady ? " is-ready" : "")} />
          <span>{dependencies === null ? "Checking" : engineReady ? "Ready" : "Engine offline"}</span>
          {!engineReady && dependencies !== null ? (
            <button
              type="button"
              onClick={() => void refreshDependencies()}
              aria-label="Check local engine again"
              title="Check local engine again"
            >
              <ArrowClockwise size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <main className="workspace">
        {error ? (
          <div className="error-toast" role="alert" tabIndex={-1} ref={errorRef}>
            <Info size={19} weight="fill" aria-hidden="true" />
            <p>{error}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss message">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {!video ? (
          <section className="empty-workbench" aria-live="polite">
            <span className="empty-status">
              {phase === "inspecting" ? <CircleNotch className="spin" size={14} aria-hidden="true" /> : <i />}
              {phase === "inspecting" ? "Analyzing video" : "Workspace empty"}
            </span>
            <h1>{phase === "inspecting" ? "Reading video details" : "No beat loaded"}</h1>
            <p>
              {phase === "inspecting"
                ? "Checking the description for tempo, key, and tuning."
                : "Paste a YouTube link in the bar above to start."}
            </p>
            {!engineReady && dependencies !== null ? (
              <div className="engine-warning">
                <Info size={17} aria-hidden="true" />
                <div>
                  <strong>Local engine needs attention</strong>
                  <span>
                    {availableDependencies} of {dependencyTotal || 4} bundled tools are available.
                  </span>
                </div>
                <button type="button" onClick={() => void refreshDependencies()}>Try again</button>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="result-grid" aria-labelledby="result-title">
            <article className="panel source-panel">
              <div className="thumbnail">
                {video.thumbnailUrl ? (
                  <img src={video.thumbnailUrl} alt={"Thumbnail for " + video.title} />
                ) : (
                  <div className="thumbnail-fallback" aria-hidden="true">
                    <YoutubeLogo size={42} weight="fill" />
                  </div>
                )}
                <span className="duration-pill">{video.isLive ? "Live" : formatDuration(video.durationSeconds)}</span>
              </div>

              <div className="source-copy">
                <span className="channel">{video.uploader ?? "Unknown channel"}</span>
                <h1 id="result-title" ref={resultHeadingRef} tabIndex={-1}>{video.title}</h1>
              </div>

              <button className="secondary-button open-source" type="button" onClick={() => void openSource()}>
                <ArrowSquareOut size={17} aria-hidden="true" />
                Open on YouTube
              </button>
            </article>

            <article className="panel analysis-panel">
              <header className="panel-heading">
                <div>
                  <span className="panel-kicker">Analysis</span>
                  <h2>Detected details</h2>
                </div>
                <span className="confidence-pill">{confidence}% confidence</span>
              </header>

              <div className="metric-layout">
                <label className="metric-card bpm-card">
                  <span className="metric-label">Tempo</span>
                  <div className="metric-value large">
                    <input
                      type="number"
                      min="30"
                      max="320"
                      step="0.1"
                      value={bpm}
                      onChange={(event) => setBpm(event.target.value)}
                      disabled={phase === "downloading"}
                      aria-label="Tempo in BPM"
                      placeholder="—"
                    />
                    <b>BPM</b>
                  </div>
                  <small>
                    {video.metadata.alternateBpms.length
                      ? "Also found " + video.metadata.alternateBpms.join(" / ") + " BPM"
                      : "Enter the beat tempo"}
                  </small>
                </label>

                <div className="metric-stack">
                  <label className="metric-card compact-card">
                    <span className="metric-label">Musical key</span>
                    <div className="metric-value">
                      <input
                        value={musicalKey}
                        onChange={(event) => setMusicalKey(event.target.value)}
                        disabled={phase === "downloading"}
                        aria-label="Musical key"
                        placeholder="Not found"
                      />
                      {video.metadata.camelot ? <b>{video.metadata.camelot}</b> : null}
                    </div>
                  </label>

                  <label className="metric-card compact-card">
                    <span className="metric-label">Detune</span>
                    <div className="metric-value">
                      <input
                        type="number"
                        min="-1200"
                        max="1200"
                        step="0.1"
                        value={detune}
                        onChange={(event) => setDetune(event.target.value)}
                        disabled={phase === "downloading"}
                        aria-label="Detune in cents"
                        placeholder="0"
                      />
                      <b>cents</b>
                    </div>
                    {video.metadata.tuningHz ? <small>A = {video.metadata.tuningHz} Hz</small> : null}
                  </label>
                </div>
              </div>

              {video.metadata.warnings.length ? (
                <div className="warning-note">
                  <Info size={17} weight="fill" aria-hidden="true" />
                  <span>{video.metadata.warnings[0]}</span>
                </div>
              ) : null}

              <div className="evidence">
                <button
                  className="evidence-toggle"
                  type="button"
                  aria-expanded={evidenceOpen}
                  onClick={() => setEvidenceOpen((current) => !current)}
                >
                  <span>
                    <strong>How this was detected</strong>
                    <small>{video.metadata.matches.length} matches in the video metadata</small>
                  </span>
                  <CaretDown className={evidenceOpen ? "is-open" : ""} size={17} aria-hidden="true" />
                </button>

                {evidenceOpen ? (
                  <div className="evidence-list">
                    {video.metadata.matches.length ? video.metadata.matches.slice(0, 4).map((match, index) => (
                      <div className="evidence-row" key={match.kind + "-" + index}>
                        <span className="match-kind">{match.kind}</span>
                        <span className="match-text">{match.rawText}</span>
                        <span className="match-source">{match.source}</span>
                      </div>
                    )) : (
                      <p className="empty-evidence">No labelled metadata was found. You can enter the values manually.</p>
                    )}
                  </div>
                ) : null}
              </div>
            </article>

            <aside className="panel export-panel">
              <header className="panel-heading export-heading">
                <div>
                  <span className="panel-kicker">Output</span>
                  <h2>Export audio</h2>
                </div>
              </header>

              <fieldset className="format-fieldset" disabled={phase === "downloading"}>
                <legend>Audio format</legend>
                <div className="format-grid">
                  {FORMATS.map((item) => (
                    <label className={"format-option" + (format === item.id ? " is-selected" : "")} key={item.id}>
                      <input
                        type="radio"
                        name="audio-format"
                        value={item.id}
                        checked={format === item.id}
                        onChange={() => setFormat(item.id)}
                      />
                      <span>{item.label}</span>
                      <small>{item.detail}</small>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="export-field">
                <label>Destination</label>
                <button
                  className="field-button"
                  type="button"
                  onClick={() => void chooseDirectory()}
                  disabled={phase === "downloading" || !native}
                  aria-label={"Choose download destination. Current folder: " + (outputDirectory || "none")}
                >
                  <FolderOpen size={17} aria-hidden="true" />
                  <span>{outputDirectory || "Choose a folder"}</span>
                  <CaretDown size={14} aria-hidden="true" />
                </button>
              </div>

              <div className="export-field">
                <div className="field-label-row">
                  <label htmlFor="file-name">File name</label>
                  <button type="button" onClick={syncFileName} disabled={phase === "downloading"}>
                    Use detected details
                  </button>
                </div>
                <div className="filename-control">
                  <input
                    id="file-name"
                    value={fileName}
                    onChange={(event) => {
                      setFileName(event.target.value);
                      setFileNameIsCustom(true);
                    }}
                    disabled={phase === "downloading"}
                  />
                  <span>{format === "original" ? "source ext." : "." + format}</span>
                </div>
              </div>

              {video.isLive ? (
                <div className="live-note">
                  <Info size={17} weight="fill" aria-hidden="true" />
                  Downloading becomes available when the stream ends.
                </div>
              ) : null}

              <div className="export-action-zone">
                {phase === "downloading" ? (
                  <div className="transfer-inline">
                    <div className="transfer-heading">
                      <span>
                        <CircleNotch className="spin" size={17} aria-hidden="true" />
                        <strong>{progress?.message ?? "Preparing download"}</strong>
                      </span>
                      <b>{Math.round(percent)}%</b>
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="Download progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(percent)}
                      aria-valuetext={(progress?.message ?? "Downloading") + ", " + Math.round(percent) + " percent"}
                    >
                      <i style={{ width: percent + "%" }} />
                    </div>
                    <div className="transfer-meta" aria-hidden="true">
                      <span>{formatBytes(progress?.downloadedBytes)} / {formatBytes(progress?.totalBytes)}</span>
                      <span>{formatSpeed(progress?.speedBytesPerSecond)}</span>
                      <span>{formatEta(progress?.etaSeconds)} left</span>
                    </div>
                    <button className="cancel-action" type="button" onClick={() => void cancel()} disabled={!activeJobId}>
                      <Stop size={14} weight="fill" aria-hidden="true" />
                      Cancel
                    </button>
                  </div>
                ) : phase === "complete" ? (
                  <div className="success-inline" role="status">
                    <div className="success-copy">
                      <span className="success-icon"><Check size={16} weight="bold" aria-hidden="true" /></span>
                      <div>
                        <strong>Saved to your computer</strong>
                        <span>{completedPath ?? outputDirectory}</span>
                      </div>
                    </div>
                    {completedPath ? (
                      <button className="primary-button" type="button" onClick={() => void revealCompletedFile()}>
                        <FolderOpen size={18} aria-hidden="true" />
                        Show in folder
                      </button>
                    ) : null}
                    <button className="download-again" type="button" onClick={() => void startDownload()}>
                      Download again
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary-button download-button"
                    type="button"
                    onClick={() => void startDownload()}
                    disabled={!outputDirectory || video.isLive}
                  >
                    <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                    <span>Download {selectedFormat.label}</span>
                    <ArrowRight size={18} weight="bold" aria-hidden="true" />
                  </button>
                )}
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
