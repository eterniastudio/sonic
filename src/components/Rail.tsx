import { Books, GearSix, Question, Tray, Waveform } from "@phosphor-icons/react";
import type { AppRoute } from "../domain/types";
import { useSonic } from "../app/SonicProvider";

const ROUTES: Array<{ id: AppRoute; label: string; icon: typeof Tray }> = [
  { id: "session", label: "Session", icon: Tray },
  { id: "library", label: "Library", icon: Books },
  { id: "settings", label: "Settings", icon: GearSix },
];

export function Rail() {
  const { state, setRoute, setShortcutsOpen } = useSonic();
  return (
    <aside className="app-rail" aria-label="Sonic navigation">
      <button className="rail-brand" type="button" onClick={() => setRoute("session")} aria-label="Sonic session">
        <Waveform size={24} weight="bold" aria-hidden="true" />
        <span>SONIC</span>
      </button>
      <nav className="rail-nav">
        {ROUTES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={state.route === id ? "is-active" : ""}
            aria-current={state.route === id ? "page" : undefined}
            onClick={() => setRoute(id)}
          >
            <Icon size={21} weight={state.route === id ? "fill" : "regular"} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <button className="rail-help" type="button" onClick={() => setShortcutsOpen(true)}>
        <Question size={20} aria-hidden="true" />
        <span>Shortcuts</span>
      </button>
    </aside>
  );
}
