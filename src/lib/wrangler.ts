import { join } from "node:path";
import { readJsonSafe, readText } from "./read.ts";

export type EdgeHost = {
    file: string;
    name: string;
    main: string | null;
    d1: unknown[];
};

type WranglerConfig = { main?: string; name?: string; d1_databases?: unknown[] };

/**
 * Finds the repo's wrangler config (toml/json/jsonc) and reads the edge
 * deployment shape from it: worker name, main entry (repo-relative by
 * convention), and d1 bindings. TOML is read by regex for `main`; JSON forms
 * are parsed after stripping comments.
 */
export function findEdgeHost(repo: string, allFiles: readonly string[]): EdgeHost | null {
    const wranglerFile = allFiles.find((f) => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(f));
    if (wranglerFile === undefined) return null;
    const text = readText(join(repo, wranglerFile))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const config = (readJsonSafe(text) ?? {}) as WranglerConfig;
    const mainMatch = config.main ?? /main\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
    return {
        file: wranglerFile,
        name: config.name ?? "worker",
        main: mainMatch ? mainMatch.replace(/^\.\//, "") : null,
        d1: config.d1_databases ?? [],
    };
}
