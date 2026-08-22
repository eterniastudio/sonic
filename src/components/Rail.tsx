import { CircleNotch, GearSix, Question, Tray, Waveform } from "@phosphor-icons/react";
import type { AppRoute } from "../domain/types";
import { useSonic } from "../app/SonicProvider";

const NAV_GROUPS: Array<{ heading: string; items: Array<{ id: AppRoute; label: string; icon: typeof Tray }> }> = [
  {
    heading: "Workspace",
    items: [{ id: "session", label: "Session", icon: Tray }],
  },
  {
    heading: "Collection",
    items: [{ id: "library", label: "Library", icon: Waveform }],
  },
  {
    heading: "System",
    items: [{ id: "settings", label: "Settings", icon: GearSix }],
  },
];

export function Rail() {
  const { state, setRoute, setShortcutsOpen, jobs } = useSonic();
  const activeCount = jobs.filter((item) =>
    ["queued", "preparing", "acquiring", "copying", "transcoding", "tagging", "validating", "publishing"].includes(item.status),
  ).length;
  const engineReady = state.diagnostics.engine.ready;

  return (
    <aside className="app-rail" aria-label="Sonic navigation">
      <button className="rail-brand" type="button" onClick={() => setRoute("session")} aria-label="Sonic session">
        <span className="rail-mark" aria-hidden="true"><Waveform size={17} weight="bold" /></span>
        <span className="rail-wordmark">SONIC</span>
      </button>

      <nav className="rail-nav" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div className="rail-group" key={group.heading}>
            <span className="rail-heading" aria-hidden="true">{group.heading}</span>
            {group.items.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`rail-item${state.route === id ? " is-active" : ""}`}
                aria-current={state.route === id ? "page" : undefined}
                onClick={() => setRoute(id)}
              >
                <Icon size={18} weight={state.route === id ? "fill" : "regular"} aria-hidden="true" />
                <span>{label}</span>
                {id === "session" && activeCount > 0 ? <b className="rail-badge" aria-label={`${activeCount} active exports`}>{activeCount}</b> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="rail-foot">
        <div className="engine-chip" role="status" aria-label={`Media engine ${engineReady ? "ready" : "not ready"}`}>
          {engineReady
            ? <span className="engine-dot is-ready" aria-hidden="true" />
            : <CircleNotch className="spin" size={12} aria-hidden="true" />}
          <span>{engineReady ? "Engine ready" : "Engine starting"}</span>
        </div>
        <button className="rail-help" type="button" onClick={() => setShortcutsOpen(true)}>
          <Question size={16} aria-hidden="true" />
          <span>Shortcuts</span>
        </button>
      </div>
    </aside>
  );
}
