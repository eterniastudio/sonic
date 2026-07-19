import type { LibraryItem, QueueItem, QueueStatus } from "./types";

export const ACTIVE_QUEUE_STATES: QueueStatus[] = [
  "preparing",
  "acquiring",
  "copying",
  "transcoding",
  "tagging",
  "validating",
  "publishing",
];

const TERMINAL_QUEUE_STATES: QueueStatus[] = ["completed", "failed", "cancelled", "interrupted"];

function comparablePath(path: string | undefined) {
  return path?.trim().replace(/\//g, "\\").toLocaleLowerCase() ?? "";
}

export function isQueueItemActive(item: QueueItem) {
  return ACTIVE_QUEUE_STATES.includes(item.status);
}

export function libraryItemMatchesQueueItem(libraryItem: LibraryItem, queueItem: QueueItem) {
  if (libraryItem.jobId && queueItem.nativeJobId === libraryItem.jobId) return true;
  if (libraryItem.clientItemId && queueItem.id === libraryItem.clientItemId) return true;
  const queueOutput = comparablePath(queueItem.outputPath);
  return Boolean(queueOutput && queueOutput === comparablePath(libraryItem.outputPath));
}

export type QueueRemovalMode = "local" | "cancel" | "remove" | "retain-library";

/**
 * Maps a renderer action to the backend lifecycle contract. Native non-terminal
 * jobs must be cancelled, while completed jobs linked to Library history must
 * retain their backing queue record until that history entry is removed.
 */
export function queueRemovalMode(item: QueueItem, library: LibraryItem[]): QueueRemovalMode {
  if (!item.nativeJobId) return "local";
  if (item.status === "completed" && library.some((entry) => libraryItemMatchesQueueItem(entry, item))) {
    return "retain-library";
  }
  return TERMINAL_QUEUE_STATES.includes(item.status) ? "remove" : "cancel";
}
