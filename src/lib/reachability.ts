import { join } from "node:path";
import type { Host } from "./hosts.ts";
import type { Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import type { Room } from "./rooms.ts";
import { OTLP_PATTERN } from "./scans.ts";
import type { EdgeHost } from "./wrangler.ts";

// package.json script entries split by naming convention: QA/codebase
// utilities (checks, linting, tests, packaging, doc indexes) versus
// operational tooling (bootstrap, certificates, backfill, deploys).
// A QA keyword in ANY segment of the script name marks it QA
// (tool:test:coverage is QA even though it starts with "tool").
const QA_SCRIPT_PATTERN =
    /(^|[:._-])(check|lint|test|typecheck|coverage|knip|audit|format|fmt|quality|adr|rfc|docs?|prepare|prepack|postinstall|release|clean|proof|prove|uat|spike|poc|bench(mark)?|inventory|crap)([:._-]|$)/i;

type FileEdge = { from: string; to: string };

function reachableFrom(roots: ReadonlySet<string>, fileEdges: readonly FileEdge[]): Set<string> {
    const importsOf = new Map<string, string[]>();
    for (const { from, to } of fileEdges) {
        importsOf.set(from, [...(importsOf.get(from) ?? []), to]);
    }
    const seen = new Set(roots);
    const queue = [...roots];
    for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
        for (const next of importsOf.get(current) ?? []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}

export type Reachability = {
    deployReachable: Set<string>;
    scriptReachable: Set<string>;
    operationalReachable: Set<string>;
    /** Files named directly by a package.json script command — identical to R1's script roots. */
    scriptReferencedFiles: Set<string>;
    isDevToolingFile: (file: string) => boolean;
};

type PackageManifest = {
    bin?: Record<string, string>;
    main?: string;
    module?: string;
    scripts?: Record<string, string>;
};

/**
 * R1: three reachability sets over the import graph. Deployed roots are files
 * baked into service images, Dockerfile entry points, the wrangler worker
 * entry, package bin/main files, and web-app entry dirs. Script roots are
 * files referenced from package.json script commands; those from scripts NOT
 * named with a QA keyword are also operational roots. A file reachable only
 * from QA scripts and from nothing that deploys is dev tooling.
 */
export function analyseReachability(
    repo: string,
    packages: readonly Package[],
    hosts: readonly Host[],
    edgeHost: EdgeHost | null,
    sourceFiles: readonly string[],
    fileEdges: readonly FileEdge[],
    fileToRoom: ReadonlyMap<string, Room>,
): Reachability {
    const resolvePathToken = (pkgDir: string, token: string): string | null => {
        const clean = token.replace(/^["']|["']$/g, "");
        if (!/[./]/.test(clean) || clean.startsWith("-")) return null;
        const candidate = join(pkgDir === "." ? "" : pkgDir, clean);
        return fileToRoom.has(candidate) ? candidate : null;
    };

    const deployRoots = new Set<string>();
    const scriptRoots = new Set<string>();
    const operationalRoots = new Set<string>();

    for (const host of hosts) {
        for (const service of host.services) {
            if (service.entryFile) deployRoots.add(service.entryFile);
            for (const copy of service.copies) {
                for (const f of sourceFiles) if (f.startsWith(`${copy.replace(/\/$/, "")}/`)) deployRoots.add(f);
            }
        }
    }
    if (edgeHost?.main && fileToRoom.has(edgeHost.main)) deployRoots.add(edgeHost.main);

    for (const pkg of packages) {
        const json = (readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {}) as PackageManifest;
        for (const binPath of Object.values(json.bin ?? {})) {
            const resolved = resolvePathToken(pkg.dir, String(binPath));
            if (resolved) deployRoots.add(resolved);
        }
        for (const field of ["main", "module"] as const) {
            const value = json[field];
            const resolved = value !== undefined && resolvePathToken(pkg.dir, String(value));
            if (resolved) deployRoots.add(resolved);
        }
        if (pkg.role === "web") {
            for (const entryDir of ["app", "pages", "src/app", "src/pages"]) {
                const prefix = pkg.dir === "." ? entryDir : join(pkg.dir, entryDir);
                for (const f of sourceFiles) if (f.startsWith(`${prefix}/`)) deployRoots.add(f);
            }
        }
        for (const [scriptName, command] of Object.entries(json.scripts ?? {})) {
            const qa = QA_SCRIPT_PATTERN.test(scriptName);
            for (const token of String(command).split(/\s+/)) {
                const resolved = resolvePathToken(pkg.dir, token);
                if (!resolved) continue;
                scriptRoots.add(resolved);
                if (!qa) operationalRoots.add(resolved);
            }
        }
    }

    const deployReachable = reachableFrom(deployRoots, fileEdges);
    const scriptReachable = reachableFrom(scriptRoots, fileEdges);
    const operationalReachable = reachableFrom(operationalRoots, fileEdges);
    const isDevToolingFile = (file: string): boolean =>
        !deployReachable.has(file) && scriptReachable.has(file) && !operationalReachable.has(file);

    return {
        deployReachable,
        scriptReachable,
        operationalReachable,
        scriptReferencedFiles: scriptRoots,
        isDevToolingFile,
    };
}

/**
 * R2: dev-tooling stripping at file granularity — files reachable only from
 * QA-named package.json scripts and imported by nothing that deploys are
 * removed from their rooms before assembly, so one operational CLI does not
 * shield a directory of QA scripts. A room that lost QA files also sheds its
 * residue: files referenced by no root whose importers are all themselves
 * stripped, iterated to a fixed point (OTLP producers exempt, as in R3).
 * Emptied rooms disappear from the map. Returns the warning lines.
 */
export function stripDevTooling(
    repo: string,
    rooms: Map<string, Room>,
    reachability: Reachability,
    fileEdges: readonly FileEdge[],
): string[] {
    const { deployReachable, scriptReachable, isDevToolingFile } = reachability;
    const warnings: string[] = [];
    for (const room of rooms.values()) {
        const excluded = room.files.filter(isDevToolingFile);
        if (!excluded.length) continue;
        room.files = room.files.filter((f) => !isDevToolingFile(f));
        const strippedFiles = new Set(excluded);
        const isQaResidue = (f: string) =>
            !deployReachable.has(f) &&
            !scriptReachable.has(f) &&
            fileEdges.every(({ from, to }) => to !== f || strippedFiles.has(from)) &&
            !OTLP_PATTERN.test(readText(join(repo, f)));
        const residue: string[] = [];
        for (;;) {
            const next = room.files.filter((f) => !strippedFiles.has(f) && isQaResidue(f));
            if (!next.length) break;
            for (const f of next) strippedFiles.add(f);
            residue.push(...next);
        }
        room.files = room.files.filter((f) => !strippedFiles.has(f));
        room.loc = room.files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
        const strippedCount = excluded.length + residue.length;
        warnings.push(
            room.files.length
                ? `Dev tooling stripped from ${room.segment}: ${strippedCount} QA-script file${strippedCount === 1 ? "" : "s"} (kept ${room.files.length} operational).`
                : `Dev tooling excluded (reachable only from QA package.json scripts): ${room.segment} (${strippedCount} files).`,
        );
    }
    return warnings;
}
