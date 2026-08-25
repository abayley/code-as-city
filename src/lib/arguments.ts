import { basename, join, resolve } from "node:path";

export type GeneratorArguments = {
    repo: string;
    outDir: string;
    modulesAsBuildings: boolean;
    overview: boolean;
};

export const USAGE = "Usage: generate-map.mjs <target-repo> [--out-dir path] [--modules-as-buildings]";

/**
 * Parses the generator's CLI arguments. Returns null when no target repo is
 * given (the caller prints USAGE and exits); paths are resolved absolute, and
 * the default out dir is out/<repo-basename>[-overview].
 */
export function parseArguments(argv: readonly string[]): GeneratorArguments | null {
    const positionals: string[] = [];
    let outDir: string | undefined;
    let modulesAsBuildings = false;
    let overview = false;
    for (let i = 0; i < argv.length; i += 1) {
        const argument = argv[i];
        if (argument === "--out-dir") {
            outDir = argv[i + 1];
            i += 1;
        } else if (argument === "--modules-as-buildings") modulesAsBuildings = true;
        else if (argument === "--overview") overview = true;
        else if (argument !== undefined) positionals.push(argument);
    }
    const target = positionals[0];
    if (!target) return null;
    const repo = resolve(target);
    return {
        repo,
        outDir: resolve(outDir ?? join("out", overview ? `${basename(repo)}-overview` : basename(repo))),
        modulesAsBuildings,
        overview,
    };
}
