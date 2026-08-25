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
export const PAPER = "#f0f0f0"; // scene background
export const PANEL = "#fafafa"; // plaques, signs, selected-text foreground

// --- Structure fills -------------------------------------------------------
export const STRUCTURE_DEFAULT = "#C77740"; // modules/deployables (function-area orange)
export const STRUCTURE_INFRA = "#283B47"; // infra nodes without a generator colour
export const STRUCTURE_EXTERNAL = "#473E29"; // external systems
export const COVERAGE_GAP = "#3F93C7"; // uncovered fraction of a building

// --- Edges ------------------------------------------------------------------
// Declared data flow draws in INK.
export const EDGE_OBSERVED = "#2e6b52"; // runtime evidence (hand-made maps only)
export const EDGE_INFERRED = INK; // data flow draws in one charcoal, declared or inferred
export const IMPORTS_OUT = "#3F93C7"; // what the selected node imports
export const IMPORTED_BY = "#3F93C7"; // what imports the selected node (dashed)

// --- Districts and rails -----------------------------------------------------
// Accents cycle per neighbourhood; plot fills are their pale companions.
export const NEIGHBORHOOD_ACCENTS = ["#d3935f", "#d4b366", "#5c7280", "#77704f", "#6ea8cf"];
export const NEIGHBORHOOD_PLOT_FILLS = ["#f1dccb", "#f0e5c8", "#d5dde2", "#e2ded0", "#d9e9f4"];

// --- Map furniture -----------------------------------------------------------
export const MARKER_MUTED = "#828282"; // footprint/outline lines at rest
export const MARKER_INTERIOR = "#0a5c4b"; // interior room footprints
export const PLAQUE_DEFAULT = "#f6f6f6";
export const PLAQUE_INFRA = "#f0f0f0";
export const PLAQUE_EXTERNAL = "#f2f0ec";
