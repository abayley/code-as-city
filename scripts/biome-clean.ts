// Biome exits zero on info-level diagnostics, and `--error-on-warnings` only
// promotes warnings, so neither alone keeps the repo biome-clean. This wrapper
// runs `biome check .` for its human-readable output, then re-reads the same
// run as JSON and fails on ANY diagnostic, whatever its severity.

import { spawnSync } from "node:child_process";

/**
 * Counts the diagnostics in a Biome JSON report.
 *
 * @param report - Raw stdout from `biome check --reporter=json`.
 * @returns The number of diagnostics, at any severity; zero when the report
 *   has none or carries no diagnostics array at all.
 */
export function diagnosticCount(report: string): number {
    const parsed = JSON.parse(report) as { diagnostics?: unknown[] };
    return parsed.diagnostics?.length ?? 0;
}

/**
 * Runs Biome over the repo and decides the process exit code.
 *
 * @returns 0 when Biome reports no diagnostics at all, 1 otherwise.
 */
export function runBiomeClean(): number {
    const pretty = spawnSync("biome", ["check", "."], { stdio: "inherit", encoding: "utf8" });
    const json = spawnSync("biome", ["check", ".", "--reporter=json", "--max-diagnostics=none"], {
        encoding: "utf8",
    });
    if (json.stdout === "") {
        console.error("biome-clean: no JSON report from biome; treating as a failure.");
        return 1;
    }
    const count = diagnosticCount(json.stdout);
    if (count > 0 && pretty.status === 0) {
        console.error(
            `biome-clean: ${count} info-level diagnostic${count === 1 ? "" : "s"} that 'biome check' alone does not fail on.`,
        );
    }
    return count > 0 || pretty.status !== 0 ? 1 : 0;
}

if (import.meta.main) {
    process.exit(runBiomeClean());
}
