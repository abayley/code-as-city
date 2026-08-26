---
id: RFC-0003
name: Migrate the viewer chrome to shadcn/ui (Base UI, Mira, Roboto)
status: Completed
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
| Completed | 2026-08-26 14:00 |

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

## Design constraint: stock components only

Added 2026-08-26 by the user, and it overrides anything below that conflicts.

- Use only stock shadcn components, added with the CLI. No custom controls,
  no hand-rolled surfaces, no bespoke visual styling.
- Prefer each component's stock variants and sizes over ad-hoc class lists.
  Layout-only utilities (positioning, grid/flex, gap, max-width) are fine;
  custom colours, borders, shadows, radii, and backdrop filters are not.
- The registry carries a primitive for nearly every piece of this chrome —
  `sidebar`, `item`, `input-group`, `card`, `table`, `empty`, `field`,
  `breadcrumb`, `toggle`/`toggle-group`, `button-group`, `hover-card`,
  `tooltip`, `kbd`, `dialog`, `scroll-area` — so reach for those first.
- If a stock component cannot express something, say so explicitly rather
  than hand-rolling it.
- The exception is the three.js scene itself (geometry, materials, camera,
  palette). DOM chrome layered over the canvas is NOT exempt: the hover card
  that follows the cursor should be a stock `hover-card`/`tooltip`.

## Goals

- All chrome rendered by STOCK shadcn/ui components (Base UI, Mira, Roboto);
  `globals.css` shrinks to canvas/layout essentials and the specificity hacks
  disappear.
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
  raycasting, and layout stay as they are. Building colours keep the light
  palette. Two scene concessions to dark mode, both forced by the dark
  background this RFC introduces: the background itself, and the ground-plane
  connection lines, which were ink on near-black and therefore invisible
  (palette.INK_ON_DARK, chosen by theme in evidenceColors). Ink drawn ON a
  light-palette building — outlines, floor lines, plaque text — is unchanged
  in both themes.
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
- Component mapping (all stock): map select -> Select; breadcrumb ->
  Breadcrumb; topbar actions -> Button / ButtonGroup; sidebar -> Sidebar
  primitives with Item rows and InputGroup search; inspector -> Card + Item
  + Table + Badge; legend and viewport overlays -> Card / Item / Toggle;
  canvas hover card -> HoverCard or Tooltip; folder dialog -> Dialog + Field
  + Input + Checkbox + Button; showcase cards -> Card; empty state -> Empty.
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

- [x] Extract the inspector panel (Card, Badges, stats), the legend, and the
      viewport overlays (view mode, location, help, Overhead toggle).
      Note from Phase 0: the overlays are dark ink and become illegible on
      the dark canvas, so they must move to theme tokens here.
      `viewer/components/inspector.tsx` (Card + Item + Table + Badge),
      `legend.tsx` and `viewport-overlays.tsx` (Card + Toggle + Button +
      Separator), and `hover-details.tsx` (the pointer-following card, now a
      controlled shadcn HoverCard anchored to a zero-size element at the
      pointer). shadcn `card`, `toggle`, `item`, `table`, and `hover-card`
      were added. Decision: chrome uses only stock shadcn components and
      their variants; the sole exception is the legend's line swatches, which
      no stock component draws. `biome.json` gained an override turning off
      `a11y/useSemanticElements` for `viewer/components/ui/**`, because
      shadcn's generated `Item`/`ItemGroup` use `role="list"` on a div and
      generated files are not hand-edited. No globals.css change was needed.
- [x] Browser smoke + screenshots (both themes, node and map inspector,
      Overhead toggle, back-to-city, hover card).

### Phase 4 — dialogs, showcase, empty state

- [x] Extract the Map-a-folder Dialog (path input, overview checkbox,
      generate flow) and the showcase cards / empty state.
      `viewer/components/folder-browser.tsx` (Dialog + Breadcrumb + Badge +
      Item/ItemGroup + Field/FieldGroup + Checkbox + Alert + Spinner + Kbd)
      and `viewer/components/empty-state.tsx` (Empty + ButtonGroup + Card).
      shadcn `dialog`, `field` (pulling `label`), `checkbox`, `alert`,
      `spinner`, `empty`, `button-group`, `breadcrumb`, and `kbd` were added.
      Decisions: the two generate buttons collapse into a Checkbox plus one
      Generate button, per this phase's brief; the row highlight uses the
      stock Item `outline` variant (Item has no selected state, and `muted`
      is invisible on the dark surface); the showcase `accent` colour is
      dropped, since a per-card border colour is bespoke styling. No
      globals.css change was needed. `biome.json` gained four more
      `viewer/components/ui/**` rule exemptions for the generated Breadcrumb,
      Field, and Label files.
- [x] Browser smoke + screenshots.

### Phase 4b — stock-component conformance

Phases 1-3 were written before the stock-only constraint and used bespoke
markup in places (a hand-built sidebar and rows, hand-styled overlays).

- [x] Rework the topbar to stock Breadcrumb (and ButtonGroup if it suits).
      The hand-made "REPOSITORY name path" cluster is now Breadcrumb /
      BreadcrumbList / BreadcrumbItem / BreadcrumbPage / BreadcrumbSeparator;
      the map-file button is a ButtonGroup with a ButtonGroupText label, and
      the two shell actions are a ButtonGroup. The ThemeToggle stays outside
      that group, since ButtonGroup joins its children into one control and a
      ghost icon button does not belong in the join.
- [x] Rework the sidebar onto the stock Sidebar primitives, Item rows, and
      InputGroup search, keeping always-open sections and behaviour.
      `sidebar` and `input-group` were added. Decision: the shell is a CSS
      grid that owns the rail's column, and the stock `Sidebar` shell is a
      fixed-position offcanvas with its own width variables, so only the
      inner primitives are used — SidebarHeader / SidebarContent /
      SidebarGroup / SidebarGroupLabel / SidebarGroupContent / SidebarMenu /
      SidebarMenuItem / SidebarMenuButton / SidebarMenuSub(Item) — inside the
      existing `aside`. SidebarMenuButton reads the provider context, so
      SidebarProvider wraps the aside with `contents`, collapsing its
      `flex min-h-svh w-full` wrapper out of the grid. Band headings are
      SidebarGroupLabel; the section header is a SidebarMenuButton with
      `isActive`; rows are SidebarMenuButton `size="lg"` inside
      SidebarMenuSub, whose token-coloured left border replaces the old
      per-district accent stripe. Decision: NEIGHBORHOOD_ACCENTS is dropped
      (from palette.ts too) — a per-district hex is exactly the bespoke
      colour the constraint forbids, and no stock component carries it.
      The search box is InputGroup + InputGroupInput + InputGroupAddon, with
      the clear button an InputGroupButton, replacing the hand-positioned
      icon and absolutely-placed clear Button.
      globals.css: the unlayered `button/input/a:focus-visible` outline and
      the `a { color: inherit }` rule were wrapped in `@layer base` (nothing
      deleted) — unlayered they beat every Tailwind utility, and the focus
      outline painted `var(--ink)` on the dark theme.
      `biome.json` gained three more `viewer/components/ui/**` exemptions
      (noDocumentCookie, useKeyWithClickEvents, useExhaustiveDependencies)
      for the generated sidebar and input-group files.
- [x] Rework any remaining hand-styled inspector, legend, or overlay markup
      onto stock Card / Item / Table / Toggle. Nothing was left: the Phase 3
      and 4 components already carry only stock components plus layout
      utilities. The two known gaps stand — the legend's line swatches (no
      stock component draws a coloured rule) and the showcase card's
      activating button (Card has no render prop).
- [x] Replace the canvas hover card with a stock HoverCard or Tooltip.
      Already done in Phase 3 (`hover-details.tsx`).
- [x] Browser smoke + screenshots (both themes).

### Phase 5 — CSS retirement

- [x] Delete the retired globals.css rules; keep only canvas/layout
      essentials; the specificity-lift hacks and reduced-motion block are
      replaced by Tailwind equivalents.
- [x] Full behaviour checklist in the browser, both themes, plus a
      `bun run build` production build check.

### Phase 6 — behaviour tests

- [x] vitest + Testing Library setup (jsdom environment for viewer tests
      only; generator tests unaffected). `vitest.config.ts` now declares two
      projects: `generator` (node, `test/**/*.test.ts`) and `viewer` (jsdom,
      `test/unit/viewer/**/*.test.tsx`, the React plugin, the `@` alias, and
      `test/unit/viewer/setup.ts`). The setup file adds jest-dom's matchers,
      an automatic `cleanup`, `matchMedia`, `scrollIntoView`, and an in-memory
      `localStorage` — node 26 defines a `localStorage` global that is
      unavailable without `--localstorage-file`, and vitest's jsdom
      environment leaves pre-existing globals alone, so jsdom's own storage
      never reaches the tests.
- [x] Behaviour tests: search filters rows; row click fires selection;
      inspector renders a node's stats/refs from fixture data; folder dialog
      validates and submits; keyboard shortcuts dispatch; theme toggle flips
      the class. No styling assertions. 33 tests over ComponentRow, Sidebar,
      Inspector, EmptyState, FolderBrowser (a hand-written recording fake for
      the `fetch` seam), and ThemeToggle with `useTheme`.
- [x] Mark this RFC completed.

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
