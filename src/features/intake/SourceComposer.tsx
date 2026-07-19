import { useState, type DragEvent, type FormEvent } from "react";
import { ClipboardText, FileAudio, LinkSimple, Plus } from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";

export function SourceComposer() {
  const { addUrls, importFiles, addLocalPaths, bridgeMode, setDropActive } = useSonic();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addUrls(value);
      setValue("");
    } finally {
      setSubmitting(false);
    }
  };

  const paste = async () => {
    try {
      const clipboard = await navigator.clipboard.readText();
      if (clipboard) setValue((current) => current ? `${current.trim()}\n${clipboard.trim()}` : clipboard.trim());
    } catch {
      document.getElementById("source-links")?.focus();
    }
  };

  const dropBrowserFiles = (event: DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    if (bridgeMode !== "preview") return;
    const paths = [...event.dataTransfer.files].map((file) => `C:\\Browser Preview\\${file.name}`);
    void addLocalPaths(paths);
  };

  return (
    <section
      className="source-composer"
      aria-labelledby="source-composer-title"
      onDragEnter={() => setDropActive(true)}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={dropBrowserFiles}
    >
      <div className="composer-heading">
        <div>
          <span className="eyebrow">New intake</span>
          <h1 id="source-composer-title">Build this session</h1>
        </div>
        {bridgeMode === "preview" ? <span className="preview-mode">Browser preview</span> : null}
      </div>
      <form className="composer-input" onSubmit={(event) => void submit(event)}>
        <LinkSimple size={20} aria-hidden="true" />
        <label className="sr-only" htmlFor="source-links">Authorized media links, one per line</label>
        <textarea
          id="source-links"
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
          }}
          placeholder="Paste one or more authorized video links"
        />
        <button className="icon-button" type="button" onClick={() => void paste()} aria-label="Paste links from clipboard" title="Paste links">
          <ClipboardText size={19} aria-hidden="true" />
        </button>
        <button className="composer-add" type="submit" disabled={!value.trim() || submitting}>
          <Plus size={18} weight="bold" aria-hidden="true" />
          <span>{submitting ? "Adding…" : "Add"}</span>
        </button>
      </form>
      <div className="composer-footer">
        <button type="button" onClick={() => void importFiles()}>
          <FileAudio size={18} aria-hidden="true" />
          Import audio files
        </button>
        <span>or drop WAV, MP3, M4A, FLAC, Opus, OGG, or WebM anywhere</span>
        <kbd>Ctrl</kbd><kbd>Enter</kbd><span className="shortcut-copy">to add links</span>
      </div>
    </section>
  );
}
