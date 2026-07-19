import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type SonicUpdate = Update;
export type SonicUpdateEvent = DownloadEvent;

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export async function checkForSonicUpdate(): Promise<SonicUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: CHECK_TIMEOUT_MS });
}

export async function installSonicUpdate(
  update: SonicUpdate,
  onEvent: (event: SonicUpdateEvent) => void,
): Promise<void> {
  await update.downloadAndInstall(onEvent, { timeout: DOWNLOAD_TIMEOUT_MS });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
