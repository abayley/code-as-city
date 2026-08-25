import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRepo = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "mini-repo");

/**
 * Writes the fixture repo's coverage-summary.json (Istanbul format keys
 * absolute file paths, so the file cannot be committed). The coverage/
 * directory is gitignored; the generator's coverage scan reads it. Idempotent
 * and deterministic, so golden maps are stable across machines.
 */
export function prepareMiniRepo(): void {
    const coverageDir = join(fixtureRepo, "coverage");
    mkdirSync(coverageDir, { recursive: true });
    const entry = (covered: number, total: number) => ({
        lines: { covered, total, pct: Math.round((covered / total) * 1000) / 10 },
    });
    const summary = {
        total: entry(10, 16),
        [join(fixtureRepo, "packages/api/src/server.ts")]: entry(6, 12),
        [join(fixtureRepo, "packages/shared/src/greeting.ts")]: entry(4, 4),
    };
    writeFileSync(join(coverageDir, "coverage-summary.json"), `${JSON.stringify(summary, null, 4)}\n`);
}
