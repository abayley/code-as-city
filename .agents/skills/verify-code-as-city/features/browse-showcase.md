# Browse a showcase

Browse a showcase lets a user open one of the bundled city maps in the viewer without mapping anything: the empty shell offers one card per showcase (titled by map name with a `language · shape` line), and the topbar showcase picker switches maps once one is loaded. The 3D city renders from the checked-in `out/` maps.

## Sub-features

- `showcase-cards` lists every bundled showcase as a card on the empty shell.
- `showcase-open` loads the picked map into the 3D scene.
- `showcase-switch` changes the loaded map from the topbar picker.
- `showcase-identity` keeps the map name and `language · shape` visible so proof artifacts identify the app.

## How to get to it (user POV)

- Open the viewer with no map loaded and choose a showcase card.
- With a map loaded, pick a different entry in the topbar showcase Select.
- Reload the viewer to return to the empty shell.

## Driving it with verify-city

Preconditions:

- Baseline preconditions from the map README hold.
- `scripts/doctor.sh` exits 0 (in particular the seven `out/` maps exist).
- The dev server is yours on port 5199 (Launch section), or the agent's browser tooling can reach it.
- Browser storage is fresh, or `code-as-city:last-folder` is cleared, so the dialog does not reopen mid-proof.

- **Empty shell.** Open `http://localhost:5199/`. The page shows the `Map a folder` button and one card per bundled showcase, each card carrying the map name and its `language · shape` line.
- **Open a map.** Choose the `aria-evals` card (or the topbar entry `aria-evals` once loaded). The 3D city scene renders and the topbar breadcrumb names the loaded map.
- **Switch maps.** Pick `nzlaw` in the topbar showcase Select. The scene reloads with the new map and the breadcrumb updates; no `Map rejected` alert appears.
- **Proof.** Capture the action and the resulting state: an aria snapshot (or DOM text) showing the map name plus a screenshot with the viewer identity visible, and record this feature ID with the `showcase-cards`/`showcase-open` entry points used. Save both under `$EVIDENCE/browse-showcase/`.

## Gotchas

- A fresh clone has no `out/` maps, so the viewer fails `typecheck`/`dev`/`build` with TS2307 on `viewer/lib/local-showcases.ts` until the maps are generated or the imports are trimmed; that is a setup state, not a showcase bug — doctor reports it.
- The 3D scene needs WebGL; a headless browser without GPU flags may render blank canvas while the DOM is correct. Assert the map name and breadcrumb in the DOM, and say so if pixels are unavailable.
- `localStorage` remembers the last browsed folder (`code-as-city:last-folder`) and the dialog reopens where it last was; stale storage can make a fresh-load proof start mid-dialog.
