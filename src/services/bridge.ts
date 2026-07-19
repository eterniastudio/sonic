import { isTauri } from "@tauri-apps/api/core";
import { BrowserPreviewBridge } from "../fixtures/preview";
import type { SonicBridge } from "./bridge-types";
import { NativeBridge } from "./native";

let instance: SonicBridge | undefined;

export function getBridge(): SonicBridge {
  if (!instance) instance = isTauri() ? new NativeBridge() : new BrowserPreviewBridge();
  return instance;
}
