// The viewer's entire colour vocabulary in one place, so trying a new
// palette is a one-file edit. Grouped by semantic role.
//
// Two colour sets live OUTSIDE this file and must be kept in step:
// - viewer/globals.css :root variables (--ink, --paper, --panel, ...): the
//   DOM chrome around the map (rails, panels, buttons, legend).
// - src/generate-map.mjs OVERVIEW_*_COLOR constants: district/module colours
//   baked into map.json as display.color (function-area teal, shared-code
//   purple, infra mauve).

// --- Neutrals -------------------------------------------------------------
export const INK = "#14202b"; // text, outlines, declared data-flow lines
export const PAPER = "#dbe5e7"; // scene background
export const PANEL = "#edf3f2"; // plaques, signs, selected-text foreground

// --- Structure fills -------------------------------------------------------
export const STRUCTURE_DEFAULT = "#81afa6"; // modules/deployables (function-area teal family)
export const STRUCTURE_INFRA = "#b17f9f"; // infra nodes without a generator colour
export const STRUCTURE_EXTERNAL = "#cf8278"; // external systems
export const COVERAGE_GAP = "#c0574a"; // uncovered fraction of a building

// --- Edges ------------------------------------------------------------------
// Declared data flow draws in INK.
export const EDGE_OBSERVED = "#3f725d"; // runtime evidence (hand-made maps only)
export const EDGE_INFERRED = "#a56f46"; // inferred data flow (dashed)
export const IMPORTS_OUT = "#2a4d9b"; // what the selected node imports
export const IMPORTED_BY = "#7c3f8f"; // what imports the selected node

// --- Districts and rails -----------------------------------------------------
// Accents cycle per neighbourhood; plot fills are their pale companions.
export const NEIGHBORHOOD_ACCENTS = ["#6d9da5", "#75967b", "#8f7da8", "#b77f8b", "#718eaf"];
export const NEIGHBORHOOD_PLOT_FILLS = ["#c8dfe2", "#cddbcf", "#d7d2e5", "#e2cfd7", "#c9d7e6"];

// --- Map furniture -----------------------------------------------------------
export const BAND_FILL_ODD = "#c5d5d8";
export const BAND_FILL_EVEN = "#e1eaeb";
export const BAND_RULE = "#83989d";
export const MARKER_MUTED = "#70878c"; // footprint/outline lines at rest
export const MARKER_INTERIOR = "#376f71"; // interior room footprints
export const PLAQUE_DEFAULT = "#e5efee";
export const PLAQUE_INFRA = "#ebe5ee";
export const PLAQUE_EXTERNAL = "#f0e5e5";
