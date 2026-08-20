import { useEffect, useRef, useState } from "react";
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
  ["Ctrl + K", "Open the command palette"],
  ["Ctrl + L", "Focus the link field"],
  ["Ctrl + O", "Choose audio files"],
  ["Ctrl + F", "Search the Library"],
  ["Space", "Play or pause the preview"],
  ["Alt + ↑ / ↓", "Move the selected queue item"],
  ["Ctrl + 1 / 2 / ,", "Switch Session, Library, or Settings"],
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close the current overlay"],
];

const TUTORIAL_STEPS = [
  { eyebrow: "01 · Intake", title: "Bring in the track", copy: "Paste authorized YouTube or SoundCloud links, or choose local audio. Add several links at once—Sonic keeps each track in its own queue row." },
  { eyebrow: "02 · Analyze", title: "Check what Sonic heard", copy: "Sonic reads declared tags and analyzes the audio locally for tempo and musical key. Reliable blank values are filled automatically; anything you edit stays authoritative." },
  { eyebrow: "03 · Shape", title: "Choose an export or stems", copy: "Export MP3, M4A, WAV, FLAC, Opus, or the original. Optional four-stem processing creates vocals, drums, bass, and other without turning Sonic into a full DAW." },
  { eyebrow: "04 · Keep", title: "Find it again", copy: "Finished tracks live in Library with their audio and .json metadata sidecar. Press Ctrl+K anytime to jump to the next action." },
] as const;

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function SonicApp() {
  const {
    state,
    importFiles,
    setRoute,
    setPlaying,
    moveItem,
    dismissError,
    setShortcutsOpen,
  } = useSonic();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const shortcutDialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shortcutsWereOpenRef = useRef(false);

  useEffect(() => {
    if (state.loading) return;
    try {
      if (localStorage.getItem("sonic:tutorial-complete") !== "1") setTutorialOpen(true);
    } catch { /* Storage can be unavailable in hardened WebViews. */ }
  }, [state.loading]);

  useEffect(() => {
    const replay = () => { setTutorialStep(0); setTutorialOpen(true); };
    window.addEventListener("sonic:replay-tutorial", replay);
    return () => window.removeEventListener("sonic:replay-tutorial", replay);
  }, []);

  const closeTutorial = () => {
    setTutorialOpen(false);
    try { localStorage.setItem("sonic:tutorial-complete", "1"); } catch { /* Optional preference only. */ }
  };

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
      if (modifier && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (modifier && ["1", "2", ","].includes(event.key)) {
        event.preventDefault();
        setRoute(event.key === "1" ? "session" : event.key === "2" ? "library" : "settings");
        return;
      }
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
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key) && state.selectedJobId) {
        event.preventDefault();
        void moveItem(state.selectedJobId, event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (event.key === "?" && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (tutorialOpen) closeTutorial();
        else if (commandPaletteOpen) setCommandPaletteOpen(false);
        else if (state.shortcutsOpen) setShortcutsOpen(false);
        else if (state.globalError) dismissError();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, dismissError, importFiles, moveItem, setPlaying, setRoute, setShortcutsOpen, state.globalError, state.player.asset, state.player.playing, state.route, state.selectedJobId, state.shortcutsOpen, tutorialOpen]);

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

      {commandPaletteOpen ? (
        <div className="modal-backdrop command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandPaletteOpen(false); }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-heading">
            <header><Keyboard size={18} aria-hidden="true" /><h2 id="command-heading">Go to a Sonic action</h2><kbd>Esc</kbd></header>
            <div className="command-list">
              <button autoFocus type="button" onClick={() => { setRoute("session"); setCommandPaletteOpen(false); requestAnimationFrame(() => document.getElementById("source-links")?.focus()); }}><span><HardDrives size={17} />Add links</span><kbd>Ctrl L</kbd></button>
              <button type="button" onClick={() => { void importFiles(); setCommandPaletteOpen(false); }}><span><HardDrives size={17} />Choose audio files</span><kbd>Ctrl O</kbd></button>
              <button type="button" onClick={() => { setRoute("library"); setCommandPaletteOpen(false); }}><span><HardDrives size={17} />Open Library</span><kbd>Ctrl 2</kbd></button>
              <button type="button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); setCommandPaletteOpen(false); }}><span><Keyboard size={17} />Replay walkthrough</span></button>
              <button type="button" onClick={() => { setShortcutsOpen(true); setCommandPaletteOpen(false); }}><span><Keyboard size={17} />Keyboard shortcuts</span><kbd>?</kbd></button>
            </div>
          </section>
        </div>
      ) : null}

      {tutorialOpen ? (
        <div className="modal-backdrop tutorial-backdrop" role="presentation">
          <section className="tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="tutorial-heading">
            <header><span className="tutorial-signal" aria-hidden="true">{TUTORIAL_STEPS.map((_, index) => <i key={index} className={index <= tutorialStep ? "is-live" : ""} />)}</span><button type="button" onClick={closeTutorial}>Skip</button></header>
            <div className="tutorial-copy"><span className="eyebrow">{TUTORIAL_STEPS[tutorialStep].eyebrow}</span><h2 id="tutorial-heading">{TUTORIAL_STEPS[tutorialStep].title}</h2><p>{TUTORIAL_STEPS[tutorialStep].copy}</p></div>
            <footer><button type="button" disabled={tutorialStep === 0} onClick={() => setTutorialStep((step) => Math.max(0, step - 1))}>Back</button>{tutorialStep === TUTORIAL_STEPS.length - 1 ? <button className="primary-action" type="button" onClick={closeTutorial}>Start using Sonic</button> : <button className="primary-action" type="button" onClick={() => setTutorialStep((step) => step + 1)}>Next</button>}</footer>
          </section>
        </div>
      ) : null}

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
