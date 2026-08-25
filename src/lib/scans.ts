import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ENTRY_FILE_PATTERN } from "./inventory.ts";
import type { Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import { kebab } from "./text.ts";

type FileCoverage = { covered: number; total: number; pct: number };

export type CoverageScan = {
    coverageByFile: Map<string, FileCoverage>;
    coverageForFiles: (files: readonly string[]) => number | null;
};

/**
 * Code coverage: Istanbul coverage-summary.json files under coverage/ dirs
 * (repo root or package roots, one suite subdir deep). Suites merge by best
 * per-file line coverage; node coverage is line-weighted over its files.
 * The coverage dir is inventory-ignored, so this scan targets it directly.
 */
export function scanCoverage(repo: string, packageDirs: readonly string[]): CoverageScan {
    const coverageByFile = new Map<string, FileCoverage>();
    for (const base of new Set([".", ...packageDirs])) {
        const coverageDir = join(repo, base === "." ? "" : base, "coverage");
        if (!existsSync(coverageDir)) continue;
        let suiteDirs: string[] = [];
        try {
            suiteDirs = readdirSync(coverageDir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => join(coverageDir, e.name));
        } catch {
            /* unreadable */
        }
        for (const candidate of [coverageDir, ...suiteDirs].map((dir) => join(dir, "coverage-summary.json"))) {
            if (!existsSync(candidate)) continue;
            const summary = (readJson(candidate) ?? {}) as Record<string, { lines?: Partial<FileCoverage> }>;
            for (const [file, stats] of Object.entries(summary)) {
                if (file === "total") continue;
                const rel = relative(repo, file);
                if (rel.startsWith("..")) continue;
                const lines = stats.lines ?? {};
                const previous = coverageByFile.get(rel);
                if (!previous || (lines.pct ?? 0) > previous.pct) {
                    coverageByFile.set(rel, {
                        covered: lines.covered ?? 0,
                        total: lines.total ?? 0,
                        pct: lines.pct ?? 0,
                    });
                }
            }
        }
    }
    const coverageForFiles = (files: readonly string[]): number | null => {
        let covered = 0;
        let total = 0;
        for (const file of files) {
            const entry = coverageByFile.get(file);
            if (entry) {
                covered += entry.covered;
                total += entry.total;
            }
        }
        return total ? Math.round((covered / total) * 1000) / 10 : null;
    };
    return { coverageByFile, coverageForFiles };
}

export type DocScanner = {
    fileDocSummary: (file: string) => string | null;
    docForFiles: (files: readonly string[]) => string | null;
};

/**
 * TSDoc extraction: the first slash-star-star block that is file-level (only
 * comments or whitespace before it) or attached to an export becomes the
 * node's prose. First paragraph only, tags dropped, capped at 280 characters.
 * For a multi-file node, the entry-like file's doc is preferred.
 */
export function createDocScanner(repo: string): DocScanner {
    const docCache = new Map<string, string | null>();
    const fileDocSummary = (file: string): string | null => {
        const cached = docCache.get(file);
        if (cached !== undefined) return cached;
        const text = readText(join(repo, file));
        let summary: string | null = null;
        const match = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(0, 4000));
        if (match) {
            const body = match[1] ?? "";
            const before = text.slice(0, match.index);
            const fileLevel = /^\s*(?:\/\/[^\n]*\n|\s)*$/.test(before);
            const onExport = /^\s*export\b/.test(text.slice(match.index + match[0].length));
            if (fileLevel || onExport) {
                const paragraph: string[] = [];
                for (const raw of body.split("\n")) {
                    const line = raw.replace(/^\s*\*? ?/, "");
                    if (/^@\w/.test(line)) break;
                    if (!line.trim() && paragraph.length) break;
                    if (line.trim()) paragraph.push(line.trim());
                }
                const joined = paragraph.join(" ").trim();
                if (joined) summary = joined.length > 280 ? `${joined.slice(0, 277)}...` : joined;
            }
        }
        docCache.set(file, summary);
        return summary;
    };
    const docForFiles = (files: readonly string[]): string | null => {
        const ordered = [...files].sort(
            (a, b) =>
                Number(ENTRY_FILE_PATTERN.test(basename(b).replace(/\.[a-z]+$/, ""))) -
                Number(ENTRY_FILE_PATTERN.test(basename(a).replace(/\.[a-z]+$/, ""))),
        );
        for (const file of ordered) {
            const summary = fileDocSummary(file);
            if (summary) return summary;
        }
        return null;
    };
    return { fileDocSummary, docForFiles };
}

export type EmbeddedDatabase = {
    id: string;
    label: string;
    depName: string;
    path: string;
    description: string;
};

// Embedded databases declared as package dependencies are deployment shape
// in both map modes. One entry per dependency repo-wide: several manifests
// declaring the same store share it.
const EMBEDDED_DB_DEPS: readonly (readonly [RegExp, string])[] = [
    [/^@lancedb\//, "LanceDB vector database"],
    [/^chromadb$/, "Chroma vector database"],
    [/^(better-sqlite3|sqlite3)$/, "SQLite database"],
    [/^(duckdb$|@duckdb\/)/, "DuckDB database"],
];

/** Finds embedded-database dependencies (LanceDB, SQLite, DuckDB, Chroma) across package manifests. */
export function findEmbeddedDatabases(packages: readonly Package[]): EmbeddedDatabase[] {
    const embeddedDatabases: EmbeddedDatabase[] = [];
    for (const pkg of packages) {
        for (const dep of Object.keys(pkg.deps ?? {})) {
            const match = EMBEDDED_DB_DEPS.find(([pattern]) => pattern.test(dep));
            if (!match) continue;
            const id = kebab(`infra-${dep}`);
            if (embeddedDatabases.some((db) => db.id === id)) continue;
            const pkgManifest = pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`;
            embeddedDatabases.push({
                id,
                label: match[1],
                depName: dep,
                path: pkgManifest,
                description: `Embedded database (${dep}) declared in ${pkgManifest}.`,
            });
        }
    }
    return embeddedDatabases;
}
