import { describe, expect, it } from "vitest";
import { diagnosticCount } from "../../scripts/biome-clean";

describe("diagnosticCount", () => {
    it("given a clean report, when counted, then it is zero", () => {
        expect(diagnosticCount(JSON.stringify({ summary: {}, diagnostics: [] }))).toBe(0);
    });

    it("given a report with no diagnostics key, when counted, then it is zero", () => {
        expect(diagnosticCount(JSON.stringify({ summary: {} }))).toBe(0);
    });

    it("given info-level diagnostics, when counted, then they count like any other severity", () => {
        const report = JSON.stringify({
            diagnostics: [{ severity: "info" }, { severity: "error" }, { severity: "warning" }],
        });
        expect(diagnosticCount(report)).toBe(3);
    });
});
