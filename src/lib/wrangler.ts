// Wrangler config scanning: the Cloudflare edge district's shape
// (HEURISTICS.md rules D7/D8).

import { dirname, join } from "node:path";
import { readJsonSafe, readText, tomlValue } from "./read.ts";

export type EdgeHost = {
    file: string;
    name: string;
    main: string | null;
    d1: unknown[];
};

type WranglerConfig = { main?: string; name?: string; d1_databases?: unknown[] };

/**
 * Finds the repo's wrangler config (toml/json/jsonc) and reads the edge
 * deployment shape from it: worker name, main entry, and d1 bindings. TOML is
 * read by regex for `name` and `main`; both patterns are anchored to the start
 * of a line so that keys ending in the same word (`database_name` in a
 * `[[d1_databases]]` block) cannot be mistaken for the top-level key. The
 * regex does not track TOML tables, so a `name` under `[env.staging]` is still
 * read as though it were top-level. JSON forms are parsed after stripping
 * comments. `main` is taken repo-relative when such a file is inventoried,
 * otherwise resolved against the config's directory.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param allFiles - The full repo inventory, searched for the wrangler
 *   config and used to validate the main entry.
 * @returns The edge host (config file, worker name, main entry, D1
 *   bindings), or null when the repo has no wrangler config.
 */
export function findEdgeHost(repo: string, allFiles: readonly string[]): EdgeHost | null {
    // HC-024: a wrangler config under a template dir is copied into USER
    // projects (paperclip's cloudflare bridge-template) — this repo deploys
    // nothing with it.
    const candidates = allFiles.filter((f) => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(f));
    const wranglerFile = candidates.find((f) => !/(^|\/)[^/]*template[^/]*\//i.test(f)) ?? null;
    if (wranglerFile === null) return null;
    const text = readText(join(repo, wranglerFile))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const config = (readJsonSafe(text) ?? {}) as WranglerConfig;
    const mainMatch = config.main ?? tomlValue(text, "main");
    let main: string | null = null;
    if (mainMatch) {
        main = mainMatch.replace(/^\.\//, "");
        if (!allFiles.includes(main)) {
            const relativeToConfig = join(dirname(wranglerFile), main);
            if (allFiles.includes(relativeToConfig)) main = relativeToConfig;
        }
    }
    return {
        file: wranglerFile,
        name: config.name ?? tomlValue(text, "name") ?? "worker",
        main,
        d1: config.d1_databases ?? [],
    };
}
