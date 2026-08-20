import { isTauri } from "@tauri-apps/api/core";
import { BrowserPreviewBridge } from "../fixtures/preview";
import type { SonicBridge } from "./bridge-types";
import { withLibraryPagination } from "./library-pagination";
import { NativeBridge } from "./native";

let instance: SonicBridge | undefined;

export function getBridge(): SonicBridge {
  if (!instance) {
    const bridge = isTauri() ? new NativeBridge() : new BrowserPreviewBridge();
    instance = withLibraryPagination(bridge);
  }
  return instance;
}
