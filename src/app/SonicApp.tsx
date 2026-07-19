import { useEffect, useRef } from "react";
import { CircleNotch, HardDrives, Keyboard, WarningCircle, X } from "@phosphor-icons/react";
import { Rail } from "../components/Rail";
import { SourceComposer } from "../features/intake/SourceComposer";
import { SourceInspector } from "../features/inspector/SourceInspector";
import { LibraryPage } from "../features/library/LibraryPage";
import { PreviewTransport } from "../features/player/PreviewTransport";
import { QueueList } from "../features/queue/QueueList";
import { SettingsPage } from "../features/settings/SettingsPage";
import { useSonic } from "./SonicProvider";

const ROUTE_LABELS = {
  session: ["Session", "Add, review, and export"],
  library: ["Library", "Your finished tracks"],
  settings: ["Settings", "Files, exports, and updates"],
} as const;

const SHORTCUTS = [
  ["Ctrl + L", "Focus the link field"],
  ["Ctrl + O", "Choose audio files"],
  ["Ctrl + F", "Search the Library"],
  ["Space", "Play or pause the preview"],
  ["Alt + ↑ / ↓", "Move the selected queue item"],
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close the current overlay"],
];

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function SonicApp() {
  const {
    state,
    importFiles,
    setRoute,
    setPlaying,
    dismissError,
    setShortcutsOpen,
  } = useSonic();
  const shortcutDialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shortcutsWereOpenRef = useRef(false);

  useEffect(() => {
    if (state.shortcutsOpen && !shortcutsWereOpenRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (!state.shortcutsOpen && shortcutsWereOpenRef.current) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
    shortcutsWereOpenRef.current = state.shortcutsOpen;
  }, [state.shortcutsOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (state.shortcutsOpen && event.key === "Tab") {
        const focusable = [...(shortcutDialogRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? [])]
          .filter((element) => !element.hasAttribute("disabled"));
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === "l") {
        event.preventDefault();
        setRoute("session");
        window.requestAnimationFrame(() => document.getElementById("source-links")?.focus());
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === "o") {
        event.preventDefault();
        void importFiles();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === "f" && state.route === "library") {
        event.preventDefault();
        document.getElementById("library-search")?.focus();
        return;
      }
      if (event.key === " " && !isTypingTarget(event.target) && state.player.asset) {
        event.preventDefault();
        setPlaying(!state.player.playing);
        return;
      }
      if (event.key === "?" && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (state.shortcutsOpen) setShortcutsOpen(false);
        else if (state.globalError) dismissError();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dismissError, importFiles, setPlaying, setRoute, setShortcutsOpen, state.globalError, state.player.asset, state.player.playing, state.route, state.shortcutsOpen]);

  if (state.loading) {
    return (
      <div className="boot-screen" role="status" aria-live="polite">
        <span className="boot-mark"><CircleNotch className="spin" size={29} aria-hidden="true" /></span>
        <strong>Opening Sonic</strong>
        <span>Loading your last session…</span>
      </div>
    );
  }

  const routeLabel = ROUTE_LABELS[state.route];
  const engineReady = state.diagnostics.engine.ready;

  return (
    <div className="sonic-shell">
      <Rail />
      <div className="app-stage">
        <header className="topbar">
          <div><strong>{routeLabel[0]}</strong><span>{routeLabel[1]}</span></div>
          <button className={`engine-indicator${engineReady ? " is-ready" : ""}`} type="button" onClick={() => setRoute("settings")}>
            <span aria-hidden="true" />
            <HardDrives size={17} aria-hidden="true" />
            <b>{engineReady ? "Ready" : "Set up media tools"}</b>
          </button>
        </header>

        <div className="route-stage">
          {state.route === "session" ? (
            <main className="session-page">
              <SourceComposer />
              <div className="session-workspace">
                <QueueList />
                <SourceInspector />
              </div>
            </main>
          ) : state.route === "library" ? <LibraryPage /> : <SettingsPage />}
        </div>
      </div>

      <PreviewTransport />

      {state.dropActive ? (
        <div className="drop-overlay" role="status" aria-live="polite">
          <span><HardDrives size={34} weight="fill" aria-hidden="true" /></span>
          <strong>Drop audio to add it</strong>
          <small>WAV, MP3, M4A, FLAC, Opus, OGG, and WebM</small>
        </div>
      ) : null}

      {state.globalError ? (
        <div className="global-toast" role="alert" tabIndex={-1}>
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <div><strong>Couldn’t complete that</strong><span>{state.globalError}</span></div>
          <button type="button" onClick={dismissError} aria-label="Dismiss error"><X size={17} aria-hidden="true" /></button>
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite" aria-atomic="true">{state.announcement}</div>

      {state.shortcutsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShortcutsOpen(false); }}>
          <section ref={shortcutDialogRef} className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-heading">
            <header><span><Keyboard size={21} aria-hidden="true" /></span><div><h2 id="shortcut-heading">Keyboard shortcuts</h2><p>Common actions, without reaching for the mouse.</p></div><button autoFocus type="button" onClick={() => setShortcutsOpen(false)} aria-label="Close shortcuts"><X size={17} aria-hidden="true" /></button></header>
            <dl>{SHORTCUTS.map(([keys, action]) => <div key={keys}><dt>{keys.split(" + ").map((key) => <kbd key={key}>{key}</kbd>)}</dt><dd>{action}</dd></div>)}</dl>
          </section>
        </div>
      ) : null}
    </div>
  );
}
