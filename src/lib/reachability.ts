// Reachability analysis over the import graph and dev-tooling stripping
// (HEURISTICS.md rules R1 and R2).

import { join } from "node:path";
import { normaliseCopyDir } from "./copy-attribution.ts";
import type { Host } from "./hosts.ts";
import { artefactEntryCandidates, type Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import type { Room } from "./rooms.ts";
import type { RunnableApp } from "./runnable.ts";
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

/**
 * Transitive closure of the import graph from the given roots. The walk
 * order is depth-first (the queue pops from the end); the result is a
 * membership set, so the order is not observable.
 *
 * @param roots - The root files seeding the traversal.
 * @param fileEdges - File-level import edges (from importer to imported).
 * @returns Every file reachable from a root, roots included.
 */
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
    /**
     * R5: files reachable from the *host* deployment roots only — compose
     * service COPYs and entries, the wrangler worker entry, and web-app entry
     * dirs — excluding package `bin`/`main`/`module` entries. A package with no
     * file in this set is reached by nothing the hosts actually deploy, so it is
     * development scaffolding (an e2e harness, a plugin SDK used only by dev
     * builds) and leaves the deployment view. Distinct from `deployReachable`,
     * which also treats every package entry as a root.
     */
    hostDeployReachable: Set<string>;
    /** Whether any host deployment root exists — R5 only fires when a real deployment shape is present. */
    hasHostDeployShape: boolean;
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
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param packages - The discovered packages, whose manifests supply
 *   bin/main/module and script roots.
 * @param hosts - The deployment hosts, whose service COPYs and entry files
 *   supply deployed roots.
 * @param edgeHost - The wrangler edge host, whose main entry deploys too
 *   (null when the repo has no wrangler config).
 * @param sourceFiles - Repo-relative paths of the analysable source files.
 * @param fileEdges - File-level import edges to traverse.
 * @param fileToRoom - Index of files placed in rooms; only such files can
 *   resolve as script or bin roots.
 * @returns The three reachability sets, the raw script-root files, and the
 *   dev-tooling predicate combining them.
 */
export function analyseReachability(
    repo: string,
    packages: readonly Package[],
    hosts: readonly Host[],
    edgeHost: EdgeHost | null,
    sourceFiles: readonly string[],
    fileEdges: readonly FileEdge[],
    fileToRoom: ReadonlyMap<string, Room>,
    runnableApps: readonly RunnableApp[],
): Reachability {
    /**
     * Resolves a manifest token (a bin/main value or a script-command word)
     * to an inventoried source file within the package.
     *
     * @param pkgDir - The package's repo-relative directory ("." for root).
     * @param token - The raw token; quotes stripped, flags and pathless
     *   words rejected.
     * @returns The repo-relative file it names, or null.
     */
    const resolvePathToken = (pkgDir: string, token: string): string | null => {
        const clean = token.replace(/^["']|["']$/g, "");
        if (!/[./]/.test(clean) || clean.startsWith("-")) return null;
        const candidate = join(pkgDir === "." ? "" : pkgDir, clean);
        return fileToRoom.has(candidate) ? candidate : null;
    };

    const deployRoots = new Set<string>();
    // Host deployment roots only (no package bin/main): the basis for R5.
    const hostDeployRoots = new Set<string>();
    const scriptRoots = new Set<string>();
    const operationalRoots = new Set<string>();

    for (const host of hosts) {
        for (const service of host.services) {
            if (service.entryFile) hostDeployRoots.add(service.entryFile);
            for (const copy of service.copies) {
                for (const f of sourceFiles) if (f.startsWith(`${normaliseCopyDir(copy)}/`)) hostDeployRoots.add(f);
            }
        }
    }
    if (edgeHost?.main && fileToRoom.has(edgeHost.main)) hostDeployRoots.add(edgeHost.main);
    for (const root of hostDeployRoots) deployRoots.add(root);

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
        // D14: a published artefact's source entry is a deploy root, so a
        // bundled library whose `module` points at a dist file (not resolvable
        // above) still keeps its source out of the R3 orphan sweep.
        if (pkg.artefact !== null) {
            const entry = artefactEntryCandidates(pkg).find((candidate) => fileToRoom.has(candidate));
            if (entry !== undefined) deployRoots.add(entry);
        }
        if (pkg.role === "web") {
            for (const entryDir of ["app", "pages", "src/app", "src/pages"]) {
                const prefix = pkg.dir === "." ? entryDir : join(pkg.dir, entryDir);
                for (const f of sourceFiles)
                    if (f.startsWith(`${prefix}/`)) {
                        deployRoots.add(f);
                        hostDeployRoots.add(f); // a web app is a real deployment shape (R5)
                    }
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
    // D16: a runnable app's entry is a deploy root, so its code survives the R3
    // orphan sweep. It is NOT a host deploy root: independent runnable apps
    // (a web SPA, a service) are separate deployments, so one must not make the
    // repo "host-shaped" and force R5 to strip the others. R5 spares runnable
    // packages directly instead.
    for (const app of runnableApps) {
        if (fileToRoom.has(app.entry)) deployRoots.add(app.entry);
    }

    const deployReachable = reachableFrom(deployRoots, fileEdges);
    const hostDeployReachable = reachableFrom(hostDeployRoots, fileEdges);
    const scriptReachable = reachableFrom(scriptRoots, fileEdges);
    const operationalReachable = reachableFrom(operationalRoots, fileEdges);
    /**
     * R2's dev-tooling test: reachable from QA scripts only — from nothing
     * that deploys and from no operationally-named script.
     *
     * @param file - Repo-relative path of the source file.
     * @returns Whether the file is dev tooling to strip.
     */
    const isDevToolingFile = (file: string): boolean =>
        !deployReachable.has(file) && scriptReachable.has(file) && !operationalReachable.has(file);

    return {
        deployReachable,
        hostDeployReachable,
        hasHostDeployShape: hostDeployRoots.size > 0,
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
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param rooms - The room map, mutated in place: stripped rooms lose files
 *   and have their loc recomputed.
 * @param reachability - The R1 reachability sets and dev-tooling predicate.
 * @param fileEdges - File-level import edges, used for the residue test.
 * @returns Warning lines recording every strip, for the map's warnings.
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
        /**
         * True when the file is residue of the strip: referenced by no
         * root, imported only by already-stripped files, and not an OTLP
         * producer (which R3's exemption keeps).
         *
         * @param f - Repo-relative path of a file remaining in the room.
         * @returns Whether the file should be stripped as residue.
         */
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
