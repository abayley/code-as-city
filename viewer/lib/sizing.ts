// Shared rendering/sizing constants for the city view. Both the ground-plane
// layout (flow-layout.ts) and the 3D scene (RepoCity.tsx) size structures,
// footprints and nameplates from the same numbers; keeping them here stops the
// two from drifting apart the way the render scales once did.
//
// Three draw scales sit side by side here because they are deliberately
// distinct, not because anyone has confirmed they should share a value:
//   - STRUCTURE_MESH_SCALE / STRUCTURE_MESH_SCALE_INTERIOR draw the solid
//     building mesh, pulled in from the edge of its plot so a building never
//     hides the nameplate of the row behind it (campus meshes stack deepest, so
//     they get their own, slightly larger scale);
//   - MARKER_FOOTPRINT_SCALE draws the on-ground footprint marker and the edge
//     router's obstacle, i.e. the plot a viewer actually reads.
// The mesh scales (0.68/0.85) sit below the marker scale (0.8) on purpose: the
// mesh must clear the nameplate in front of it, the marker need not. They look
// close together today by history, not necessity. Retuning one is a visual
// change: check it in the viewer before assuming the others should follow.

/**
 * The [width, height, depth] footprint a node falls back to when it declares no
 * `display.size`. Shared by every site that reads a node's footprint so the
 * default stays identical across the layout and the scene.
 */
export const DEFAULT_FOOTPRINT: readonly [number, number, number] = [1.65, 1.2, 1.4];

/**
 * The scale applied to a non-campus structure's footprint to get the solid mesh
 * it draws. Smaller than {@link MARKER_FOOTPRINT_SCALE} on purpose: the mesh is
 * pulled in from the edge of its plot so a building never occludes the nameplate
 * standing in front of the row behind it.
 */
export const STRUCTURE_MESH_SCALE = 0.68;

/**
 * The mesh scale for a campus structure (one with an interior). Campus buildings
 * stack deepest, so they draw slightly larger than a plain structure
 * ({@link STRUCTURE_MESH_SCALE}) while still clearing the nameplates in front.
 */
export const STRUCTURE_MESH_SCALE_INTERIOR = 0.85;

/**
 * The scale applied to a node's footprint to get its on-ground plot extent:
 * used both by MapMarker's footprint outline and by the edge router when it
 * rasterises buildings as obstacles, so the corridors the router keeps open
 * line up with the plots a viewer actually sees. Larger than the mesh scales
 * ({@link STRUCTURE_MESH_SCALE}) because the plot marker has no nameplate to
 * clear.
 */
export const MARKER_FOOTPRINT_SCALE = 0.8;

/**
 * Which nameplate size band a structure's plaque uses. `landmark` is a campus
 * (a node with an interior) seen from outside, `interior` is that campus seen
 * from within, `quieter` is an external dependency, and `standard` is an
 * ordinary building.
 */
export type PlaqueVariant = "interior" | "landmark" | "quieter" | "standard";

/** A plaque's un-scaled dimensions and label font sizes for one variant. */
export type PlaqueMetrics = {
    width: number;
    height: number;
    codeFontSize: number;
    labelFontSize: number;
};

/**
 * Per-variant nameplate band. `width` grows linearly with the label length
 * (`widthBase + labelLength * widthPerChar`) clamped to `[widthMin, widthMax]`;
 * every other dimension is fixed per variant. One row per {@link PlaqueVariant}
 * so a variant is retuned in exactly one place.
 */
type PlaqueBand = {
    widthBase: number;
    widthPerChar: number;
    widthMin: number;
    widthMax: number;
    height: number;
    codeFontSize: number;
    labelFontSize: number;
};

const PLAQUE_BANDS: Record<PlaqueVariant, PlaqueBand> = {
    interior: {
        widthBase: 1.08,
        widthPerChar: 0.045,
        widthMin: 1.5,
        widthMax: 2.4,
        height: 0.58,
        codeFontSize: 0.13,
        labelFontSize: 0.17,
    },
    landmark: {
        widthBase: 2.1,
        widthPerChar: 0.065,
        widthMin: 3.15,
        widthMax: 4.7,
        height: 1.02,
        codeFontSize: 0.2,
        labelFontSize: 0.29,
    },
    quieter: {
        widthBase: 1.75,
        widthPerChar: 0.05,
        widthMin: 2.35,
        widthMax: 3.65,
        height: 0.76,
        codeFontSize: 0.145,
        labelFontSize: 0.205,
    },
    standard: {
        widthBase: 1.9,
        widthPerChar: 0.058,
        widthMin: 2.6,
        widthMax: 4.1,
        height: 0.88,
        codeFontSize: 0.17,
        labelFontSize: 0.24,
    },
};

/** Clamps `value` into the inclusive [low, high] range. */
function clamp(value: number, low: number, high: number) {
    return Math.max(low, Math.min(high, value));
}

/**
 * Chooses the nameplate {@link PlaqueVariant} for a structure from the three
 * facts that drive it, so the layout (which only ever renders the outside view)
 * and the scene (which also renders the inside view) pick the band the same
 * way. `interior` wins first (a campus seen from within), then a campus seen
 * from outside is a `landmark`, then an external dependency is `quieter`, and
 * anything else is `standard`.
 *
 * @param input.interior - The structure is being drawn as an interior (campus
 *   seen from within). The layout never sets this.
 * @param input.hasInterior - The structure has an interior (it is a campus).
 * @param input.isExternal - The node is an external dependency
 *   (`node.kind === "external"`).
 */
export function plaqueVariantFor(input: {
    interior: boolean;
    hasInterior: boolean;
    isExternal: boolean;
}): PlaqueVariant {
    if (input.interior) return "interior";
    if (input.hasInterior) return "landmark";
    if (input.isExternal) return "quieter";
    return "standard";
}

/**
 * Computes a plaque's un-scaled metrics for a nameplate variant and label
 * length. Callers multiply the returned dimensions by their own labelScale (0.4
 * for campus-scale nameplates, 1 for interiors). The width grows linearly with
 * the label length within per-variant bounds; the height and font sizes are
 * fixed per variant.
 *
 * @param variant - The nameplate size band.
 * @param labelLength - The label's character count (campuses add a few for the
 *   interior badge).
 * @returns The plaque `width`, `height`, `codeFontSize` and `labelFontSize`
 *   before labelScale is applied.
 */
export function plaqueMetrics(variant: PlaqueVariant, labelLength: number): PlaqueMetrics {
    const band = PLAQUE_BANDS[variant];
    return {
        width: clamp(band.widthBase + labelLength * band.widthPerChar, band.widthMin, band.widthMax),
        height: band.height,
        codeFontSize: band.codeFontSize,
        labelFontSize: band.labelFontSize,
    };
}
