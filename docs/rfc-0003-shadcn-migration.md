---
id: RFC-0003
name: Migrate the viewer chrome to shadcn/ui (Base UI, Mira, Roboto)
status: Draft
owners:
    - alistairbayley
created: 2026-08-26
updated: 2026-08-26
supersedes: []
superseded_by: null
---

# Migrate the viewer chrome to shadcn/ui (Base UI, Mira, Roboto)

| Stage     | Timestamp        |
|-----------|------------------|
| Authored  | 2026-08-26 11:30 |
| Started   | 2026-08-26 12:20 |
| Completed |                  |

## Summary

Replace the viewer's hand-rolled HTML chrome (~1600 lines of globals.css and
the UI markup inside RepoCity.tsx) with shadcn/ui components on the Base UI
primitives, Mira style, Roboto type, initialised via

```bash
bunx --bun shadcn@latest init --preset b1D0dwB6 --template vite
```

Light and dark themes both ship, including the map background and the
in-viewport buttons/legend. The chrome moves out of RepoCity.tsx into
`viewer/components/`; the react-three-fiber scene structure and its
building/edge palette are untouched (palette.ts gains only a dark
background counterpart). A final phase adds behaviour-only UI
tests (no styling or visual assertions). This is a deliberate restyle: the
chrome's appearance changes to Mira's look, so review is visual (browser
screenshots per phase), not golden-diff.

## Problem statement

The chrome is a monolith: RepoCity.tsx mixes the r3f scene with the topbar,
sidebar, inspector, legend, dialogs, and their state; globals.css carries
~1600 lines of bespoke rules including specificity-lifting hacks
(`*:not(#specificity-a)...`, `footer:not(.specificity-lift)`) introduced to
satisfy lint without `!important`. None of it is testable, themable, or
reusable, and the plan has always been to replace it with shadcn once the
generator work settled.

## Context

- Viewer today: plain Vite + React 19 + react-three-fiber; entry
  `viewer/main.tsx`, everything in `viewer/RepoCity.tsx` (~1900 lines,
  12 components), styles in `viewer/globals.css` using `--ink/--paper/--mid`
  root variables. No Tailwind.
- The shadcn init preset (b1D0dwB6) selects Base UI primitives, the Mira
  style, and Roboto. shadcn's Vite template assumes a `src/` layout and a
  Tailwind (v4, `@tailwindcss/vite`) pipeline; this repo's app root is
  `viewer/` with `index.html` at the repo root, so `components.json` aliases
  and the Tailwind content globs must be pointed at `viewer/`.
- Scene colours live in `viewer/lib/palette.ts` plus three generator-baked
  `OVERVIEW_*_COLOR` constants; by decision they do NOT follow Mira — the
  restyle is chrome-only.
- Chrome inventory (from the class-name survey): shell/topbar (repo badge,
  breadcrumb, map select, Map-a-folder and Open-map actions), sidebar
  (search box with clear, neighbourhood sections, component rows with
  index numbers, entry-point eyebrows), inspector panel (eyebrows,
  description, source-file ref tags, stats rows, stat actions), viewport
  overlays (view-mode line, location, help line, Overhead toggle, legend
  lines), showcase cards and the empty state, the folder dialog, and a
  footer. Keyboard shortcuts and the `handleKeyDown` behaviour must survive
  unchanged.
- UI tests were deliberately deferred until this migration; behaviour-only
  tests (no styling assertions) arrive as the final phase.

## Phase Item Completion Instructions

Update this plan document as you go. When an item is complete, immediately
mark it as complete in the phase checklist.

## Goals

- All chrome rendered by shadcn/ui components (Base UI, Mira, Roboto) styled
  with Tailwind tokens; `globals.css` shrinks to canvas/layout essentials and
  the specificity hacks disappear.
- Light and dark themes, class-strategy toggle, persisted preference.
- Chrome extracted into `viewer/components/` with typed props; RepoCity.tsx
  keeps only the scene graph, camera, and selection state it owns.
- Behaviour parity: selection, hover, search filtering, keyboard shortcuts,
  showcase opening, folder mapping, deep links (`sourceHref`) all work as
  before.
- Behaviour-only component tests at the end (vitest + Testing Library).
- `bun run check` green at every commit; generator goldens are unaffected by
  definition (no generator changes) and must stay untouched.

## Non-Goals

- No scene-structure changes: OVERVIEW_* constants, geometry, camera,
  raycasting, and layout stay as they are. Building/edge colours keep the
  light palette; the one scene concession to dark mode is the background
  (see Proposal), plus any ground-plot/nameplate contrast tweak that the
  dark background forces.
- No decomposition of the scene graph or its hooks — chrome extraction only.
- No visual-regression or styling tests.
- No generator or map-schema changes.

## Proposal

- Adopt Tailwind v4 + shadcn (Base UI primitives, Mira, Roboto) via the given
  init command, adjusted to the `viewer/` root. Roboto is self-hosted (
  fontsource) rather than fetched from a CDN, keeping the viewer offline-
  capable and deterministic.
- Theme: Mira's token set on `:root`/`.dark`, toggle in the topbar, stored in
  localStorage; `--ink/--paper/--mid` consumers move to the Mira tokens.
- Dark mode covers the whole viewport: the scene background (today
  `<color attach="background" args={[SCENE_PAPER]} />` from palette.ts
  PAPER) switches to a dark equivalent when the dark theme is active, and
  the in-viewport chrome (Overhead toggle, legend, view-mode/location/help
  overlays) follows the Mira dark tokens. Building and edge colours stay
  light-palette; if ground plots or nameplates lose legibility on the dark
  background, the minimal contrast fix is in scope and noted in HEURISTICS'
  colour-coupling note if palette.ts gains a dark-background constant.
- Component mapping (indicative): map select -> Select/Combobox; Map-a-folder
  -> Dialog + Input + Checkbox (overview mode) + Button; sidebar -> Input
  (search) + ScrollArea + always-open sections + row buttons with Badge for
  entry points; inspector -> Card + Badge (tags/refs) + a small stats table;
  legend and viewport overlays -> lightweight styled divs with Mira tokens
  (not everything needs a component); toasts/errors -> whatever the folder
  dialog uses today, kept simple.
- Extraction: one file per chrome area under `viewer/components/`, props-in/
  callbacks-out (no context object in the first pass); RepoCity.tsx renders
  them and keeps ownership of selection/camera state.
- Each phase ends with a browser smoke test (dev server, both modes, one
  showcase opened, selection exercised) and screenshots for review, since
  appearance changes are intended and cannot be golden-diffed.

## Alternatives Considered

- Restyle the existing CSS by hand to a Mira-like look: rejected — keeps the
  monolith and the bespoke CSS burden; the component library is the point.
- Radix primitives instead of Base UI: rejected — the chosen preset is Base
  UI, and the components come from the preset.
- Pixel-identical port before restyling: rejected — double work; the restyle
  is deliberate and reviewed visually.

## Security Impact

None beyond new dev dependencies. No external font/CDN fetches at runtime
(fonts self-hosted).

## Reliability Impact

- Risk: Tailwind preflight (CSS reset) altering canvas/layout or troika text
  measurement. Mitigation: phase 0 is init-only with the app still rendering
  before any component moves; preflight conflicts resolved there.
- Risk: chrome extraction breaking selection/keyboard behaviour. Mitigation:
  behaviour checklist exercised per phase in the browser; behaviour tests in
  the final phase pin it.

## Compatibility Impact

- Viewer-only. The map schema, generator, and vendored validator are
  untouched; showcase imports from `out/` keep working.
- `bun run dev`/`build` unchanged in usage; Vite config gains the Tailwind
  plugin.

## Testing and Quality Gates

- `bun run check` green at every commit (tsc strict, biome, knip, tests).
- Browser smoke per phase: dev server, open a showcase, select a building,
  search, toggle overhead, open the folder dialog, switch theme — plus
  screenshots for user review.
- Final phase: behaviour-only tests with vitest + @testing-library/react
  (jsdom), driving extracted chrome components with fixture map data — the
  r3f scene excluded. Assertions on behaviour (filtering, selection callbacks,
  dialog flow, keyboard shortcuts), never on classes or colours.

## Rollout Plan

### Phase 0 — toolchain

- [x] Run the init command; point components.json aliases and Tailwind
      content at `viewer/`; add the Tailwind Vite plugin; self-host Roboto.
- [x] Reconcile Tailwind preflight with the existing app: viewer renders
      exactly as before (globals.css still in charge), canvas unaffected.
      Nothing was needed beyond the cascade itself: Tailwind's preflight sits
      in `@layer base`, and globals.css is unlayered, so the old rules win
      until each is deleted.
- [x] Wire the theme provider and class-strategy dark mode (toggle can be
      temporary); verify both themes render. The scene background moved here
      too (it needed the same state): palette.ts gains PAPER_DARK and the
      canvas follows the theme. Chrome tokens are live but still overridden
      by globals.css, so chrome appearance changes land per phase below.

### Phase 1 — shell and topbar

- [x] Extract the shell/topbar to `viewer/components/` on Mira tokens:
      repo badge, breadcrumb, map Select, action Buttons, theme toggle.
      One `Topbar` serves both `MapViewer` and `EmptyShell`; shadcn `select`,
      `badge`, and `separator` were added. Note: globals.css's
      `button, input { font: inherit; color: inherit }` had to move into
      `@layer base` (nothing deleted) — unlayered, it beat every Tailwind
      utility and left the migrated buttons dark-on-dark.
- [x] Browser smoke + screenshots (both themes).

### Phase 2 — sidebar

- [x] Extract the component list: search Input with clear, neighbourhood
      sections, rows with index numbers and entry-point badges; keyboard
      behaviour preserved. `viewer/components/sidebar.tsx` (rail, search,
      always-open sections) and `viewer/components/component-row.tsx` (row)
      take a view model built in `MapViewer`; shadcn `input` was added. No
      globals.css change was needed — the Phase 1 `@layer base` move already
      covers `button, input`, and nothing else targets bare elements.
- [x] Browser smoke + screenshots.

### Phase 3 — inspector, legend, overlays

- [ ] Extract the inspector panel (Card, Badges, stats), the legend, and the
      viewport overlays (view mode, location, help, Overhead toggle).
      Note from Phase 0: the overlays are dark ink and become illegible on
      the dark canvas, so they must move to theme tokens here.
- [ ] Browser smoke + screenshots.

### Phase 4 — dialogs, showcase, empty state

- [ ] Extract the Map-a-folder Dialog (path input, overview checkbox,
      generate flow) and the showcase cards / empty state.
- [ ] Browser smoke + screenshots.

### Phase 5 — CSS retirement

- [ ] Delete the retired globals.css rules; keep only canvas/layout
      essentials; the specificity-lift hacks and reduced-motion block are
      replaced by Tailwind equivalents.
- [ ] Full behaviour checklist in the browser, both themes, plus a
      `bun run build` production build check.

### Phase 6 — behaviour tests

- [ ] vitest + Testing Library setup (jsdom environment for viewer tests
      only; generator tests unaffected).
- [ ] Behaviour tests: search filters rows; row click fires selection;
      inspector renders a node's stats/refs from fixture data; folder dialog
      validates and submits; keyboard shortcuts dispatch; theme toggle flips
      the class. No styling assertions.
- [ ] Mark this RFC completed.

### Rollout Plan Escape Hatch

- If implementation reaches behaviour that this RFC or its design contracts
  do not cover, stop changing the affected scope before inventing a contract.
- Add the smallest missing decision to `## Open Questions`, or to the owning
  RFC if another RFC owns the contract.
- Include evidence, impact, options, and a recommended path.
- Continue the affected implementation only after explicit reviewer or user
  approval.

## Open Questions

None — the two originally open items are decided: dark mode includes the map
background and the in-viewport buttons/legend (Proposal), and sidebar
sections stay always-open (Phase 2).
