// Dockerfile parsing: which source dirs a service image bakes in and which
// file it runs (HEURISTICS.md rule D3).

import { join } from "node:path";
import { readJsonSafe, readText } from "./read.ts";

export type DockerfileShape = {
    copies: string[];
    entryFile: string | null;
};

/**
 * Extracts a Dockerfile's repo-relative COPY sources (only those that exist
 * in the inventory) and its entry file: the first token naming an inventoried
 * file across every ENTRYPOINT/CMD line, in file order, so that the split form
 * (ENTRYPOINT names the interpreter, CMD the script) and multi-stage builds
 * both resolve. Paths are taken repo-relative, matching the monorepo
 * convention of building from the repo root.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param path - Repo-relative path of the Dockerfile.
 * @param allFiles - The full repo inventory, used to validate COPY sources
 *   and entry tokens against real files.
 * @returns The inventoried COPY sources and the entry file (null when no
 *   ENTRYPOINT/CMD token names an inventoried file).
 */
export function parseDockerfile(repo: string, path: string, allFiles: readonly string[]): DockerfileShape {
    const text = readText(join(repo, path));
    const copies = [...text.matchAll(/^COPY\s+([^\s]+)\s/gm)]
        // A COPY source is repo-relative; a leading `./` (immich's convention,
        // `COPY ./server ./server/`) is the same path the inventory records
        // without the prefix, so normalise it before matching.
        .flatMap((m) => (m[1] === undefined ? [] : [m[1].replace(/^\.\//, "")]))
        .filter(
            (p) => !p.startsWith("--") && allFiles.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`)),
        );
    // Every ENTRYPOINT/CMD line is considered, in file order: the split form
    // (ENTRYPOINT names the interpreter, CMD names the script) and multi-stage
    // builds both put the interesting token on a later line than the first.
    let entryFile: string | null = null;
    for (const match of text.matchAll(/^(?:ENTRYPOINT|CMD)\s+(\[.*\]|.+)$/gm)) {
        const entryMatch = match[1];
        if (entryMatch === undefined) continue;
        const parsed = entryMatch.startsWith("[") ? (readJsonSafe(entryMatch) ?? []) : entryMatch.split(/\s+/);
        const tokens = Array.isArray(parsed) ? parsed : [];
        const found = tokens.find((t): t is string => typeof t === "string" && allFiles.includes(t));
        if (found !== undefined) {
            entryFile = found;
            break;
        }
    }
    return { copies, entryFile };
}
