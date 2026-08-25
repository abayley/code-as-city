// Package discovery from package.json manifests, with role classification
// (HEURISTICS.md rule S1).

import { basename, dirname, join, sep } from "node:path";
import { readJson } from "./read.ts";
import { kebab } from "./text.ts";

type PackageRole = "cli" | "web" | "package";

export type Package = {
    dir: string;
    name: string;
    deps: Record<string, string>;
    role: PackageRole;
    id: string;
};

type PackageManifest = {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin?: Record<string, string>;
};

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
        const hasBin = json.bin && Object.keys(json.bin).length > 0;
        const isWebApp = ["react", "next", "vinext", "vue", "svelte"].some((d) => deps[d]);
        return {
            dir,
            name: json.name ?? (dir === "." ? basename(repo) : basename(dir)),
            deps,
            role: hasBin ? ("cli" as const) : isWebApp ? ("web" as const) : ("package" as const),
            id: kebab(json.name ?? basename(dir === "." ? repo : dir)),
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
