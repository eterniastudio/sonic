# Sonic v0.2 design QA

## Visual direction

The visual direction was established from two user-provided references: a
dark desktop music-production workspace and a high-contrast red campaign
layout.

Sonic uses the references' music-software character—continuous near-black
canvas, compact charcoal controls, narrow display type, restrained red signal
color, subtle borders, and dense desktop proportions—without copying their
kanban structure or marketing composition.

The v0.2 interface is a producer workstation rather than a dashboard of
decorative cards:

- fixed icon rail for Session, Library, Settings, and shortcuts;
- thin operational top bar with engine health;
- full-width source intake;
- queue and source inspector as the primary Session work surface;
- data-forward Beat Library table and selected-item detail;
- grouped Settings with engine and diagnostics status; and
- persistent waveform transport across routes.

## Captures

Committed product capture:

- `docs/sonic-workstation.png` — Session at 1440 × 900.

Ignored Playwright QA captures:

- `output/playwright/sonic-session-release.png`
- `output/playwright/sonic-library-1440.png`
- `output/playwright/sonic-settings-1440.png`
- `output/playwright/sonic-session-960x680-final.png`
- `output/playwright/sonic-shortcuts-960x680.png`

## Browser verification

The browser-preview bridge was exercised in a real Chromium instance through
the Playwright CLI.

### 1440 × 900

- Session fills the viewport exactly (`scrollHeight === innerHeight === 900`)
  while the queue and inspector retain independent scrolling.
- The fixed 76px transport no longer covers the inspector action footer.
- Queue rows preserve title, creator, musical data, state, filename, progress,
  reorder, retry/cancel, and removal affordances without horizontal overflow.
- Remote preview is explicitly disabled until export; local preview remains a
  real action.
- Library table, missing-file state, detail metrics, preview/reveal/re-export,
  history removal, and audio+sidecar deletion all remain visually distinct.
- Settings clearly separates defaults, naming, limits, engine health, and
  redacted diagnostics.

### 960 × 680 minimum window

- Session changes to a vertical queue/inspector flow with no horizontal page
  overflow.
- Rail labels, intake actions, queue data, and fixed transport remain usable.
- Compact half/double tempo controls keep visible `½` and `2×` glyphs rather
  than collapsing into blank buttons.
- The shortcut dialog fits the viewport and preserves its close action,
  keyboard legend, focus trap, Escape handling, and focus return.

### Interaction and semantics

- Multi-line intake, unique-source handling, inspection state, and review
  transition are covered by the browser bridge and component tests.
- Queue progress exposes a named semantic `progressbar`.
- Session and Library result collections use valid list/listitem ownership.
- Declared, Embedded, and Final metadata remain distinguishable to visual and
  assistive-technology users.
- Keyboard focus uses a high-contrast offset ring that is independent of the
  red selection state.
- Reduced-motion preferences disable nonessential transitions.
- Tempo correction and tap tempo are disabled outside Session so they cannot
  mutate a hidden queue item from Library or Settings.
- Axe reports no violations in the application smoke and intake flows.

## Issues found and corrected during QA

1. The desktop Session workspace extended beneath the fixed transport. Its
   height calculation and desktop bottom padding were corrected so the action
   footer is always visible at 1440 × 900.
2. Half/double tempo labels were hidden at compact widths, leaving empty
   buttons. Dedicated compact glyphs now remain visible.
3. Transport tempo tools remained active on Library and Settings and could
   modify the last selected Session job. Editing is now route-scoped.
4. Browser fixture metadata omitted title/artist values from inspector fields.
   The fixture now represents the real post-inspection state.
5. An `article role="listitem"` pairing failed axe's allowed-role rules. Queue
   items now use valid listitem containers.
6. Remote YouTube preview appeared actionable before a local asset existed.
   The control now states **Preview after export** and directs users to Library.

## Automated gate

- 54 frontend tests pass across eight files.
- Axe semantic/accessibility gate passes.
- Coverage: 98.22% statements, 79.79% branches, 95.83% functions, and 98.52%
  lines.
- TypeScript check and Vite production build pass.
- Stable clean reload produces no application console error. A transient
  provider remount error was observed only while Vite hot-reloaded files being
  actively replaced; it disappeared on the subsequent clean reload.

## Result

No remaining P0, P1, or P2 visual, responsive, interaction, or accessibility
issue was found in the verified v0.2 browser-preview states.

Final result: passed.
