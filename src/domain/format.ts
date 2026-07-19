export function formatDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`
    : `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

export function formatSpeed(bytes?: number) {
  return bytes === undefined ? "—" : `${formatBytes(bytes)}/s`;
}

export function formatEta(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  return rounded >= 60 ? `${Math.floor(rounded / 60)}m ${rounded % 60}s` : `${rounded}s`;
}

export function shortPath(value: string, maxLength = 46) {
  if (value.length <= maxLength) return value;
  const head = Math.floor((maxLength - 1) * 0.4);
  const tail = maxLength - head - 1;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "Draft",
    inspecting: "Inspecting",
    review: "Ready for review",
    queued: "Queued",
    preparing: "Preparing",
    acquiring: "Acquiring",
    copying: "Copying",
    transcoding: "Transcoding",
    tagging: "Writing metadata",
    writingMetadata: "Writing metadata",
    validating: "Validating",
    publishing: "Publishing",
    completed: "Completed",
    failed: "Needs attention",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  };
  return labels[status] ?? status;
}
