import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleNotch,
  FileAudio,
  Pause,
  Play,
  Plus,
  Stop,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatBytes, formatEta, formatSpeed, statusLabel } from "../../domain/format";
import { ACTIVE_QUEUE_STATES, isQueueItemActive, queueRemovalMode } from "../../domain/queue";
import type { QueueItem } from "../../domain/types";

function StatusIcon({ item }: { item: QueueItem }) {
  if (ACTIVE_QUEUE_STATES.includes(item.status) || item.status === "inspecting") return <CircleNotch className="spin" size={16} aria-hidden="true" />;
  if (item.status === "completed") return <Check size={16} weight="bold" aria-hidden="true" />;
  if (["failed", "interrupted"].includes(item.status)) return <WarningCircle size={16} weight="fill" aria-hidden="true" />;
  if (item.status === "cancelled") return <Stop size={14} weight="fill" aria-hidden="true" />;
  return <span className="status-dot" aria-hidden="true" />;
}

export function QueueList() {
  const {
    state,
    jobs,
    selectedJob,
    selectJob,
    enqueueAllReady,
    clearCompleted,
    setQueuePaused,
    moveItem,
    retryItem,
    removeItem,
    cancelItem,
  } = useSonic();
  const readyCount = jobs.filter((item) => item.status === "review").length;
  const finished = jobs.filter((item) => ["completed", "cancelled"].includes(item.status));
  const clearableFinishedCount = finished.filter((item) => queueRemovalMode(item, state.library) !== "retain-library").length;
  const retainedCompletedCount = finished.length - clearableFinishedCount;

  return (
    <section className="queue-panel" aria-labelledby="session-queue-heading">
      <header className="section-toolbar">
        <div>
          <span className="eyebrow">Session queue</span>
          <h2 id="session-queue-heading">{jobs.length} {jobs.length === 1 ? "item" : "items"}</h2>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void setQueuePaused(!state.queuePaused)} aria-pressed={state.queuePaused}>
            {state.queuePaused ? <Play size={16} weight="fill" aria-hidden="true" /> : <Pause size={16} weight="fill" aria-hidden="true" />}
            {state.queuePaused ? "Resume" : "Pause"}
          </button>
          {readyCount ? (
            <button className="toolbar-primary" type="button" onClick={() => void enqueueAllReady()}>
              <Plus size={16} weight="bold" aria-hidden="true" /> Queue {readyCount}
            </button>
          ) : null}
        </div>
      </header>

      {state.queuePaused ? (
        <div className="queue-paused" role="status">
          <Pause size={15} weight="fill" aria-hidden="true" />
          Queue dispatch is paused. Any active export will finish safely.
        </div>
      ) : null}

      {jobs.length ? (
        <div className="queue-list" role="list" aria-label="Current session sources">
          {jobs.map((item, index) => {
            const selected = selectedJob?.id === item.id;
            const active = isQueueItemActive(item);
            const failed = ["failed", "interrupted"].includes(item.status);
            const reorderable = ["review", "queued"].includes(item.status);
            const removalMode = queueRemovalMode(item, state.library);
            const cancellable = removalMode === "cancel";
            const percent = Math.max(0, Math.min(100, item.progress.percent ?? 0));
            return (
              <div
                key={item.id}
                className={`queue-row status-${item.status}${selected ? " is-selected" : ""}`}
                role="listitem"
                onKeyDown={(event) => {
                  if (reorderable && event.altKey && event.key === "ArrowUp") {
                    event.preventDefault();
                    void moveItem(item.id, -1);
                  }
                  if (reorderable && event.altKey && event.key === "ArrowDown") {
                    event.preventDefault();
                    void moveItem(item.id, 1);
                  }
                }}
              >
                <button
                  className="queue-select"
                  type="button"
                  onClick={() => selectJob(item.id)}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="queue-art" aria-hidden="true">
                    {item.inspection?.thumbnailUrl ? <img src={item.inspection.thumbnailUrl} alt="" /> : <FileAudio size={22} />}
                  </span>
                  <span className="queue-main">
                    <span className="queue-title">{item.inspection?.title ?? (item.source.kind === "localFile" ? item.source.path.split(/[\\/]/).pop() : "Reading video")}</span>
                    <span className="queue-subtitle">
                      {item.inspection?.creator ?? item.inspection?.sourceLabel ?? (item.source.kind === "youtube" ? "YouTube" : "Local file")}
                    </span>
                  </span>
                  <span className="queue-metadata" aria-label="Musical metadata">
                    {item.metadata.bpm ? <b>{item.metadata.bpm} BPM</b> : <b>Tempo —</b>}
                    <span>{item.metadata.key || "Key —"}</span>
                  </span>
                  <span className="queue-state">
                    <span className="state-label"><StatusIcon item={item} />{statusLabel(item.status)}</span>
                    <span>{item.progress.message ?? (item.filenamePreview || "Waiting for source details")}</span>
                  </span>
                </button>

                {(active || item.status === "queued") ? (
                  <div
                    className="row-progress"
                    role="progressbar"
                    aria-label={`${item.inspection?.title ?? "Export"} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(percent)}
                    aria-valuetext={`${statusLabel(item.status)}, ${Math.round(percent)} percent`}
                  ><i style={{ width: `${percent}%` }} /></div>
                ) : null}

                <div className="queue-row-footer">
                  <span>
                    {active ? `${formatBytes(item.progress.downloadedBytes)} · ${formatSpeed(item.progress.speedBytesPerSecond)} · ${formatEta(item.progress.etaSeconds)} left` : item.filenamePreview}
                  </span>
                  <div className="row-actions">
                    <button type="button" disabled={index === 0 || !reorderable} onClick={() => void moveItem(item.id, -1)} aria-label={`Move ${item.inspection?.title ?? "item"} up`}>
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled={index === jobs.length - 1 || !reorderable} onClick={() => void moveItem(item.id, 1)} aria-label={`Move ${item.inspection?.title ?? "item"} down`}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                    {cancellable ? (
                      <button type="button" onClick={() => void cancelItem(item.id)} aria-label={`Cancel ${item.inspection?.title ?? "export"}`}><Stop size={14} weight="fill" aria-hidden="true" /></button>
                    ) : failed || item.status === "cancelled" ? (
                      <button type="button" onClick={() => void retryItem(item.id)} aria-label={`Retry ${item.inspection?.title ?? "item"}`}><Play size={14} weight="fill" aria-hidden="true" /></button>
                    ) : null}
                    {removalMode === "local" || removalMode === "remove" ? (
                      <button type="button" onClick={() => void removeItem(item.id)} aria-label={`Remove ${item.inspection?.title ?? "item"}`}><Trash size={14} aria-hidden="true" /></button>
                    ) : removalMode === "retain-library" ? (
                      <span className="queue-history-note" title="This completed job backs its Beat Library history record.">In Library</span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="queue-empty">
          <FileAudio size={31} aria-hidden="true" />
          <h3>Your session is clear</h3>
          <p>Add links or local audio above. Sonic will inspect every source before anything is exported.</p>
        </div>
      )}

      {clearableFinishedCount ? (
        <button className="clear-completed" type="button" onClick={() => void clearCompleted()}>
          <Trash size={15} aria-hidden="true" /> Clear removable finished items
        </button>
      ) : null}
      {retainedCompletedCount ? (
        <p className="retained-history-note">
          {retainedCompletedCount} completed {retainedCompletedCount === 1 ? "export stays" : "exports stay"} here because {retainedCompletedCount === 1 ? "it backs" : "they back"} Beat Library history.
        </p>
      ) : null}
    </section>
  );
}
