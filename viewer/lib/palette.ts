// The viewer's entire colour vocabulary in one place, so trying a new
// palette is a one-file edit. Grouped by semantic role.
//
// Two colour sets live OUTSIDE this file and must be kept in step:
// - viewer/globals.css :root variables (--ink, --paper, --panel, ...): the
//   DOM chrome around the map (rails, panels, buttons, legend).
// - src/generate-map.mjs OVERVIEW_*_COLOR constants: district/module colours
//   baked into map.json as display.color (function-area blue, shared-code
//   gold, infra slate).

// --- Neutrals -------------------------------------------------------------
export const INK = "#202020"; // text, outlines, declared data-flow lines
export const PAPER = "#f0f0f0"; // scene background (light theme)
// Dark-theme scene background, matching Mira's dark --background token so
// the map and the chrome share one ground.
export const PAPER_DARK = "#0f0f0f";
// Ink drawn straight onto the dark background (the ground-plane connection
// lines). Ink on a light-palette building stays INK in both themes; only
// marks competing with the canvas itself need this counterpart.
export const INK_ON_DARK = "#d8d8d8";
export const PANEL = "#fafafa"; // plaques, signs, selected-text foreground

// --- Structure fills -------------------------------------------------------
export const STRUCTURE_DEFAULT = "#C77740"; // modules/deployables (function-area orange)
export const STRUCTURE_INFRA = "#283B47"; // infra nodes without a generator colour
export const STRUCTURE_EXTERNAL = "#473E29"; // external systems
export const COVERAGE_GAP = "#3F93C7"; // uncovered fraction of a building

// --- Edges ------------------------------------------------------------------
// Declared and inferred data flow both draw in the theme's canvas-facing ink
// (INK on paper, INK_ON_DARK on the dark canvas); see evidenceColors().
export const EDGE_OBSERVED = "#2e6b52"; // runtime evidence (hand-made maps only)
export const IMPORTS_OUT = "#3F93C7"; // what the selected node imports

// --- Districts ---------------------------------------------------------------
// Plot fills cycle per district. The matching rail accents were retired
// with the sidebar's move to stock shadcn components (RFC-0003 Phase 4b).
export const DISTRICT_PLOT_FILLS = ["#f1dccb", "#f0e5c8", "#d5dde2", "#e2ded0", "#d9e9f4"];

// --- Map furniture -----------------------------------------------------------
export const MARKER_MUTED = "#828282"; // footprint/outline lines at rest
export const MARKER_INTERIOR = "#0a5c4b"; // interior room footprints
export const PLAQUE_DEFAULT = "#f6f6f6";
export const PLAQUE_INFRA = "#f0f0f0";
export const PLAQUE_EXTERNAL = "#f2f0ec";
