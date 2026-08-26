// Package discovery from package.json manifests, with role classification
// (HEURISTICS.md rule S1).

import { basename, dirname, join, sep } from "node:path";
import { readJson } from "./read.ts";
import { kebab } from "./text.ts";

type PackageRole = "cli" | "web" | "package";

/**
 * D14: a published deployment artefact declared by a non-private package.json.
 * `kind` picks the archetype family (a CLI entry is a gateway, a library is a
 * building, an extension its own), `tag` is the marker the viewer keys on, and
 * `entry` is the raw manifest entry (the `bin` target, `main`/`module`, an
 * `exports` main, or the extension `main`) resolved to a source file later.
 */
type PublishedArtefact = {
    kind: "cli" | "library" | "extension";
    tag: "cli" | "published" | "extension";
    entry: string | null;
};

export type Package = {
    dir: string;
    name: string;
    deps: Record<string, string>;
    role: PackageRole;
    id: string;
    /** D14 published-artefact classification, or null when the package publishes nothing. */
    artefact: PublishedArtefact | null;
};

type PackageManifest = {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin?: Record<string, string> | string;
    main?: string;
    module?: string;
    exports?: unknown;
    engines?: { vscode?: string };
    contributes?: unknown;
};

/**
 * The first entry path an `exports` field points at: the string form, a `.`
 * subpath, or the first nested condition (`import`/`require`/`default`).
 *
 * @param exports - The manifest `exports` field, of unknown shape.
 * @returns The first entry path found, or null.
 */
function firstExportEntry(exports: unknown): string | null {
    if (typeof exports === "string") return exports;
    if (exports === null || typeof exports !== "object") return null;
    const record = exports as Record<string, unknown>;
    const root = record["."] ?? Object.values(record)[0];
    if (typeof root === "string") return root;
    if (root !== null && typeof root === "object") {
        const conditions = root as Record<string, unknown>;
        for (const key of ["import", "require", "default"]) {
            const value = conditions[key];
            if (typeof value === "string") return value;
        }
    }
    return null;
}

/**
 * D14: classifies a package.json as a published deployment artefact. A private
 * package publishes nothing. Otherwise `bin` makes a CLI, `engines.vscode` or a
 * `contributes` block makes a VS Code extension, and a `main`/`module`/`exports`
 * entry makes a published library. Detection order is CLI, then extension, then
 * library.
 *
 * @param manifest - The parsed package.json.
 * @returns The artefact classification, or null.
 */
function classifyArtefact(manifest: PackageManifest): PublishedArtefact | null {
    if (manifest.private === true) return null;
    const binEntry = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (binEntry !== undefined) return { kind: "cli", tag: "cli", entry: binEntry };
    const isExtension = manifest.engines?.vscode !== undefined || manifest.contributes !== undefined;
    if (isExtension) {
        return { kind: "extension", tag: "extension", entry: manifest.main ?? null };
    }
    const libraryEntry = manifest.main ?? manifest.module ?? firstExportEntry(manifest.exports);
    if (libraryEntry !== undefined && libraryEntry !== null && manifest.name !== undefined) {
        return { kind: "library", tag: "published", entry: libraryEntry };
    }
    return null;
}

/**
 * D14: the candidate source-entry paths for a package's published artefact, in
 * preference order. A bundled library's declared `module` (dist/name.core.mjs)
 * rarely maps to a source file by name, so the declared entry (with the
 * dist->src and .m/cjs->ts conventions) is tried first, then the conventional
 * source entries. The caller picks the first that exists. Empty when the
 * package publishes nothing.
 *
 * @param pkg - The package whose artefact entry to resolve.
 * @returns Repo-relative candidate source paths, most specific first.
 */
export function artefactEntryCandidates(pkg: Package): string[] {
    if (pkg.artefact === null) return [];
    const inPkg = (rel: string) => (pkg.dir === "." ? rel : `${pkg.dir}/${rel}`);
    const declared = pkg.artefact.entry;
    return [
        ...(declared === null
            ? []
            : [
                  inPkg(declared),
                  inPkg(declared)
                      .replace(/(^|\/)dist\//, "$1src/")
                      .replace(/\.[mc]?js$/, ".ts"),
                  inPkg(declared).replace(/\.[mc]?js$/, ".ts"),
              ]),
        inPkg("src/index.ts"),
        inPkg("src/index.tsx"),
        inPkg("index.ts"),
        inPkg("src/main.ts"),
    ];
}

/**
 * The directories (repo-relative, "." for the root) containing a package.json.
 *
 * @param allFiles - The full repo inventory.
 * @returns The package directories in inventory order.
 */
export function packageDirsOf(allFiles: readonly string[]): string[] {
    return allFiles.filter((f) => basename(f) === "package.json").map((f) => dirname(f));
}

/**
 * Discovers the repo's packages: one per package.json, with merged
 * dependencies and a role classified from them (bin entries make a cli,
 * web-framework dependencies make a web app, anything else is a package).
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param packageDirs - Repo-relative directories containing a package.json.
 * @returns One Package per directory: name (falling back to the directory
 *   or repo basename), merged dependencies, role, and kebab-cased id.
 */
export function discoverPackages(repo: string, packageDirs: readonly string[]): Package[] {
    return packageDirs.map((dir) => {
        const json = (readJson(join(repo, dir === "." ? "" : dir, "package.json")) ?? {}) as PackageManifest;
        const deps = { ...json.dependencies, ...json.devDependencies };
        const binCount = typeof json.bin === "string" ? 1 : Object.keys(json.bin ?? {}).length;
        const hasBin = binCount > 0;
        const isWebApp = ["react", "next", "vinext", "vue", "svelte"].some((d) => deps[d]);
        return {
            dir,
            name: json.name ?? (dir === "." ? basename(repo) : basename(dir)),
            deps,
            role: hasBin ? ("cli" as const) : isWebApp ? ("web" as const) : ("package" as const),
            id: kebab(json.name ?? basename(dir === "." ? repo : dir)),
            artefact: classifyArtefact(json),
        };
    });
}

/**
 * The deepest package whose directory contains the file (the root package matches everything).
 *
 * @param packages - The discovered packages.
 * @param file - Repo-relative path of the file to place.
 * @returns The owning package, or null when nothing (not even a root
 *   package) contains the file.
 */
export function owningPackage(packages: readonly Package[], file: string): Package | null {
    let best: Package | null = null;
    for (const pkg of packages) {
        if (pkg.dir === "." || file === pkg.dir || file.startsWith(pkg.dir + sep)) {
            if (!best || pkg.dir.length > best.dir.length) best = pkg;
        }
    }
    return best;
}
