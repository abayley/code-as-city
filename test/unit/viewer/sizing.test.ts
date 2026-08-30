// Unit tests for the shared rendering/sizing constants and the plaque-metric
// formula that flow-layout and RepoCity's MapMarker both depend on. Pure
// module, so it runs in the node project (see flow-layout.test.ts for why a
// plain `.test.ts` under test/unit/viewer lands there).
import { describe, expect, it } from "vitest";
import {
    DEFAULT_FOOTPRINT,
    MARKER_FOOTPRINT_SCALE,
    type PlaqueVariant,
    plaqueMetrics,
    plaqueVariantFor,
    STRUCTURE_MESH_SCALE,
    STRUCTURE_MESH_SCALE_INTERIOR,
} from "../../../viewer/lib/sizing";

describe("DEFAULT_FOOTPRINT", () => {
    it("is the [width, height, depth] fallback used when a node declares no size", () => {
        expect(DEFAULT_FOOTPRINT).toEqual([1.65, 1.2, 1.4]);
    });
});

describe("draw scales", () => {
    it("keeps the mesh scales below the marker scale so meshes clear their nameplates", () => {
        expect(STRUCTURE_MESH_SCALE).toBe(0.68);
        expect(STRUCTURE_MESH_SCALE_INTERIOR).toBe(0.85);
        expect(MARKER_FOOTPRINT_SCALE).toBe(0.8);
        expect(STRUCTURE_MESH_SCALE).toBeLessThan(MARKER_FOOTPRINT_SCALE);
    });
});

describe("plaqueVariantFor", () => {
    it("picks interior first, even for a campus that is also external", () => {
        expect(plaqueVariantFor({ interior: true, hasInterior: true, isExternal: true })).toBe("interior");
    });

    it("picks landmark for a campus seen from outside", () => {
        expect(plaqueVariantFor({ interior: false, hasInterior: true, isExternal: false })).toBe("landmark");
    });

    it("prefers landmark over quieter when a campus is also external", () => {
        expect(plaqueVariantFor({ interior: false, hasInterior: true, isExternal: true })).toBe("landmark");
    });

    it("picks quieter for a non-campus external dependency", () => {
        expect(plaqueVariantFor({ interior: false, hasInterior: false, isExternal: true })).toBe("quieter");
    });

    it("falls back to standard for an ordinary building", () => {
        expect(plaqueVariantFor({ interior: false, hasInterior: false, isExternal: false })).toBe("standard");
    });
});

describe("plaqueMetrics", () => {
    // Label lengths chosen to sit inside each variant's linear window (away
    // from both clamps) so the formula, not the clamp, is exercised.
    const samples: Array<
        [PlaqueVariant, number, { width: number; height: number; codeFontSize: number; labelFontSize: number }]
    > = [
        ["interior", 20, { width: 1.08 + 20 * 0.045, height: 0.58, codeFontSize: 0.13, labelFontSize: 0.17 }],
        ["landmark", 25, { width: 2.1 + 25 * 0.065, height: 1.02, codeFontSize: 0.2, labelFontSize: 0.29 }],
        ["quieter", 25, { width: 1.75 + 25 * 0.05, height: 0.76, codeFontSize: 0.145, labelFontSize: 0.205 }],
        ["standard", 25, { width: 1.9 + 25 * 0.058, height: 0.88, codeFontSize: 0.17, labelFontSize: 0.24 }],
    ];

    for (const [variant, labelLength, expected] of samples) {
        it(`computes the ${variant} width, height and font sizes from the label length`, () => {
            expect(plaqueMetrics(variant, labelLength)).toEqual(expected);
        });
    }

    it("clamps the width to each variant's minimum for a short label", () => {
        expect(plaqueMetrics("interior", 0).width).toBe(1.5);
        expect(plaqueMetrics("landmark", 0).width).toBe(3.15);
        expect(plaqueMetrics("quieter", 0).width).toBe(2.35);
        expect(plaqueMetrics("standard", 0).width).toBe(2.6);
    });

    it("clamps the width to each variant's maximum for a very long label", () => {
        expect(plaqueMetrics("interior", 1000).width).toBe(2.4);
        expect(plaqueMetrics("landmark", 1000).width).toBe(4.7);
        expect(plaqueMetrics("quieter", 1000).width).toBe(3.65);
        expect(plaqueMetrics("standard", 1000).width).toBe(4.1);
    });
});
