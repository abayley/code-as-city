// The coverage, TSDoc, and embedded-database scans shared by both map modes
// (HEURISTICS.md rules M12, M13, and D13/O11).

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ENTRY_FILE_PATTERN } from "./inventory.ts";
import type { Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import { kebab } from "./text.ts";

export const OTLP_PATTERN = /@opentelemetry\/|otlp|OTEL_EXPORTER/i;

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
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param packageDirs - Repo-relative package directories, each a candidate
 *   coverage/ location alongside the repo root.
 * @returns The per-file coverage index and an aggregator producing a node's
 *   line-weighted coverage percentage over its files.
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
    /**
     * Line-weighted coverage over the node's files.
     *
     * @param files - Repo-relative paths of the node's files.
     * @returns The percentage (one decimal place), or null when no file has
     *   coverage data.
     */
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
 * node's prose. A Python module's leading `"""` docstring (HC-026) reads the
 * same way. First paragraph only, tags dropped, capped at 280 characters.
 * For a multi-file node, the entry-like file's doc is preferred.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @returns Accessors for one file's doc summary and for the best summary
 *   across a node's files, memoised per file.
 */
export function createDocScanner(repo: string): DocScanner {
    const docCache = new Map<string, string | null>();
    /**
     * Trims a doc body to its first paragraph, capped at 280 characters.
     *
     * @param lines - The doc body split into lines.
     * @param stripStars - Whether to strip leading `*` continuations (TSDoc).
     * @returns The first paragraph, or null when empty.
     */
    const firstParagraph = (lines: readonly string[], stripStars: boolean): string | null => {
        const paragraph: string[] = [];
        for (const raw of lines) {
            const line = stripStars ? raw.replace(/^\s*\*? ?/, "") : raw.trim();
            if (/^@\w/.test(line)) break;
            if (!line.trim() && paragraph.length) break;
            if (line.trim()) paragraph.push(line.trim());
        }
        const joined = paragraph.join(" ").trim();
        if (!joined) return null;
        return joined.length > 280 ? `${joined.slice(0, 277)}...` : joined;
    };
    /**
     * M13 for one file: the first qualifying doc block's first paragraph,
     * tags dropped, capped at 280 characters.
     *
     * @param file - Repo-relative path of the source file.
     * @returns The summary, or null when no qualifying block exists.
     */
    const fileDocSummary = (file: string): string | null => {
        const cached = docCache.get(file);
        if (cached !== undefined) return cached;
        const text = readText(join(repo, file));
        let summary: string | null = null;
        // HC-026: a Python module's leading triple-quoted docstring is its
        // file-level prose, as TSDoc is for TypeScript.
        const pyMatch = file.endsWith(".py") ? /^"""([\s\S]*?)"""/.exec(text) : null;
        if (pyMatch) {
            summary = firstParagraph((pyMatch[1] ?? "").split("\n"), false);
        } else {
            const match = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(0, 4000));
            if (match) {
                const body = match[1] ?? "";
                const before = text.slice(0, match.index);
                const fileLevel = /^\s*(?:\/\/[^\n]*\n|\s)*$/.test(before);
                const onExport = /^\s*export\b/.test(text.slice(match.index + match[0].length));
                if (fileLevel || onExport) summary = firstParagraph(body.split("\n"), true);
            }
        }
        docCache.set(file, summary);
        return summary;
    };
    /**
     * The best doc summary for a multi-file node: entry-named files are
     * tried first, then the rest in given order.
     *
     * @param files - Repo-relative paths of the node's files.
     * @returns The first summary found, or null.
     */
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
    [/^embedded-postgres$/, "PostgreSQL database"],
];

/**
 * Finds embedded-database dependencies (LanceDB, SQLite, DuckDB, Chroma) across package manifests
 * (the D13/O11 scan).
 *
 * @param packages - The discovered packages, whose merged dependencies are
 *   matched against the known embedded-database SDKs.
 * @returns One database per dependency repo-wide, each carrying its id,
 *   label, dependency name, and the manifest declaring it.
 */
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

/** An external service a package talks to, declared by a client-SDK dependency (D17). */
export type ExternalServiceDep = {
    id: string;
    label: string;
    /** The SDK dependency names that map to this service, for import detection. */
    depNames: string[];
    path: string;
    description: string;
};

// Client SDKs whose presence in a package's dependencies names an external
// system it talks to (D17). Deliberately precise: `@anthropic-ai/tokenizer` and
// `mailparser` are offline libraries, not clients, so they are not matched.
// Vendor-biased like D5's tables; one node per service, several SDKs folding to
// the same one. Firebase/Socket.IO/Sentry joined under HC-019.
const EXTERNAL_SERVICE_DEPS: readonly (readonly [RegExp, string])[] = [
    [/^(imapflow|node-imap|imap|emailjs-imap-client)$/, "IMAP mail server"],
    [/^nodemailer$/, "SMTP mail server"],
    [/^@anthropic-ai\/(sdk|claude-agent-sdk|claude-code)$/, "Anthropic API"],
    [/^openai$/, "OpenAI API"],
    [/^(@google\/generative-ai|@google\/genai)$/, "Google Gemini API"],
    [/^ollama$/, "Ollama"],
    [/^cohere-ai$/, "Cohere API"],
    [/^@mistralai\//, "Mistral API"],
    [/^groq-sdk$/, "Groq API"],
    [/^stripe$/, "Stripe API"],
    [/^twilio$/, "Twilio API"],
    [/^firebase$/, "Firebase"],
    [/^socket\.io-client$/, "Socket.IO server"],
    [/^@sentry\//, "Sentry"],
];

/**
 * An endpoint-override row: the env var whose reference in an importer of one
 * of `deps`' SDKs resolves the service to `label`'s backend (HC-019).
 */
export type EndpointEnvOverride = {
    /** Token-boundary matcher for the env var, tested against comment-stripped source. */
    pattern: RegExp;
    /** The backend the service resolves to. */
    label: string;
    /** The SDK dependency names that route by base URL, so can be redirected. */
    deps: readonly string[];
};

/**
 * D17 endpoint resolution (HC-019): env vars that redirect a client SDK's
 * base URL to a different backend. When an importer of one of the named SDKs
 * references the env var, that service resolves to the backend — ollama-code's
 * `openai` SDK pointed at `OLLAMA_BASE_URL` is an Ollama server, not the
 * OpenAI cloud. Scoped to the SDKs that route by base URL: a file may import
 * several SDKs and mention the env var for one of them, and only that one
 * resolves. Token-boundary matchers, so a longer name sharing the prefix
 * (`OLLAMA_BASE_URL_DEFAULT`) does not resolve the service.
 */
export const ENDPOINT_ENV_OVERRIDES: readonly EndpointEnvOverride[] = [
    { pattern: /\bOLLAMA_BASE_URL\b/, label: "Ollama", deps: ["openai"] },
];

/**
 * The external node's id for a service label — the one home for the
 * `external-<label>` format, so detection and endpoint resolution cannot
 * diverge.
 *
 * @param label - The external service's display label.
 * @returns The kebab-cased node id.
 */
export function externalNodeId(label: string): string {
    return kebab(`external-${label}`);
}

/**
 * D17: finds the external services a repo talks to, from client-SDK
 * dependencies in package manifests. One entry per distinct service repo-wide;
 * several SDKs (or manifests) naming the same service fold to one, collecting
 * their dependency names for later import detection.
 *
 * @param packages - The discovered packages, whose merged dependencies are
 *   matched against the known client-SDK table.
 * @returns One entry per external service, in first-encounter order.
 */
export function findExternalServiceDeps(packages: readonly Package[]): ExternalServiceDep[] {
    const byLabel = new Map<string, ExternalServiceDep>();
    for (const pkg of packages) {
        const pkgManifest = pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`;
        for (const dep of Object.keys(pkg.deps ?? {})) {
            const match = EXTERNAL_SERVICE_DEPS.find(([pattern]) => pattern.test(dep));
            if (!match) continue;
            const label = match[1];
            let entry = byLabel.get(label);
            if (entry === undefined) {
                entry = {
                    id: externalNodeId(label),
                    label,
                    depNames: [],
                    path: pkgManifest,
                    description: `External service (${label}) addressed via a client SDK declared in ${pkgManifest}.`,
                };
                byLabel.set(label, entry);
            }
            if (!entry.depNames.includes(dep)) entry.depNames.push(dep);
        }
    }
    return [...byLabel.values()];
}
