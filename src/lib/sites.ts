// Platform site deployments: apps shipped to static-site hosts through a
// checked-in config (HEURISTICS.md rule D18, HC-025's first slice —
// netlify.toml and vercel.json; ECS task definitions and quadlet units are a
// later slice). A site yields a site district with a gateway deployable:
// name from the owning package, build from the config's command, entry from
// its publish/output dir.

import { basename, join } from "node:path";
import { isTestPath } from "./inventory.ts";
import { owningPackage, type Package } from "./packages.ts";
import { readJsonSafe, readText, tomlValue } from "./read.ts";

type SitePlatform = "vercel" | "netlify";

/** One platform-declared site: its config, platform, build, and owning package. */
export type SiteHost = {
    file: string;
    platform: SitePlatform;
    buildCommand: string | null;
    publishDir: string | null;
    pkgDir: string;
};

type VercelConfig = { buildCommand?: string; outputDirectory?: string };

/**
 * D18: finds the repo's platform site deployments. Each `vercel.json` or
 * `netlify.toml` outside test paths and template dirs (a config copied into
 * user projects deploys nothing from this repo, as D7's template guard holds)
 * declares one site owned by its deepest containing package.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param allFiles - The full repo inventory, searched for site configs.
 * @param packages - The discovered packages, for config ownership.
 * @returns One SiteHost per site config, in inventory order.
 */
export function findSiteHosts(repo: string, allFiles: readonly string[], packages: readonly Package[]): SiteHost[] {
    const sites: SiteHost[] = [];
    for (const file of allFiles) {
        const base = basename(file);
        const platform: SitePlatform | null =
            base === "vercel.json" ? "vercel" : base === "netlify.toml" ? "netlify" : null;
        if (platform === null) continue;
        if (isTestPath(file)) continue;
        if (/(^|\/)[^/]*template[^/]*\//i.test(file)) continue;
        const owner = owningPackage(packages, file);
        if (!owner) continue;
        const text = readText(join(repo, file));
        let buildCommand: string | null = null;
        let publishDir: string | null = null;
        if (platform === "vercel") {
            const config = (readJsonSafe(text) ?? {}) as VercelConfig;
            buildCommand = config.buildCommand ?? null;
            publishDir = config.outputDirectory ?? null;
        } else {
            buildCommand = tomlValue(text, "command");
            publishDir = tomlValue(text, "publish");
        }
        sites.push({ file, platform, buildCommand, publishDir, pkgDir: owner.dir });
    }
    return sites;
}

/**
 * The display short name of a site's owning package: the directory basename,
 * or the repo basename for a root-owned site.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param pkgDir - The owning package's repo-relative directory.
 * @returns The short name used for the site district and deployable.
 */
export function siteShortName(repo: string, pkgDir: string): string {
    return pkgDir === "." ? basename(repo) : basename(pkgDir);
}
