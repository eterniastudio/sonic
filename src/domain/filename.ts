import type { FilenamePreviewRequest, FilenameTemplate, QueueItem } from "./types";

const INVALID_WINDOWS_CHARACTERS = /[<>:"/\\|?*%]/g;

export function safeFileStem(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f]/g, "")
    .replace(INVALID_WINDOWS_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 150);
  const deviceName = sanitized.split(".")[0]?.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName) ? `_${sanitized}` : sanitized;
}

function cleanTemplateResult(value: string) {
  return value
    .replace(/\[\s*\]/g, "")
    .replace(/(?:\s*[—–-]\s*){2,}/g, " — ")
    .replace(/_+/g, "_")
    .replace(/\s+([\]}])/g, "$1")
    .replace(/([\[{])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^(?:\s*[—–_-]\s*)+/g, "")
    .replace(/(?:\s*[—–_-]\s*)+$/g, "")
    .trim();
}

export function renderFilename(request: FilenamePreviewRequest, extension: string) {
  const { source, metadata, template, presetId } = request;
  const bpm = metadata.bpm.trim();
  const detuneNumber = Number(metadata.detuneCents);
  const detune = metadata.detuneCents.trim() && Number.isFinite(detuneNumber) && Math.abs(detuneNumber) >= 0.05
    ? `${detuneNumber > 0 ? "+" : ""}${metadata.detuneCents.trim()}c`
    : "";
  const values: Record<string, string> = {
    title: metadata.title?.trim() || source.title,
    producer: metadata.artist?.trim() || source.creator || "",
    bpm,
    key: metadata.key.trim(),
    camelot: metadata.camelot !== undefined ? metadata.camelot : source.metadata.camelot ?? "",
    detune,
    preset: presetId,
    source: source.kind === "youtube" ? "YouTube" : "Local",
    date: new Date().toISOString().slice(0, 10),
  };
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => values[key] ?? "");
  const stem = safeFileStem(cleanTemplateResult(rendered)) || safeFileStem(source.title) || "Sonic export";
  return extension === "source" ? `${stem}.source` : `${stem}.${extension}`;
}

export function templateForItem(item: QueueItem, templates: FilenameTemplate[]) {
  if (item.customTemplate?.trim()) return item.customTemplate;
  return templates.find((template) => template.id === item.templateId)?.template
    ?? templates[0]?.template
    ?? "{title} — {bpm} BPM — {key}{detune}";
}
