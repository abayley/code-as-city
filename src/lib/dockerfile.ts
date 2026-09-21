// Dockerfile parsing: which source dirs a service image bakes in and which
// file it runs (HEURISTICS.md rule D3).

import { join } from "node:path";
import { readJsonSafe, readText } from "./read.ts";

export type DockerfileShape = {
    copies: string[];
    entryFile: string | null;
    /** REVIEW-0010: the ENTRYPOINT/CMD runs a known dev server. */
    devServer?: boolean | undefined;
};

/**
 * Extracts a Dockerfile's repo-relative COPY sources (only those that exist
 * in the inventory) and its entry file: the first token naming an inventoried
 * file across every ENTRYPOINT/CMD line, in file order, so that the split form
 * (ENTRYPOINT names the interpreter, CMD the script) and multi-stage builds
 * both resolve. Paths are taken repo-relative, matching the monorepo
 * convention of building from the repo root. When the Dockerfile builds
 * against a subdirectory context (HC-017), a source that matches nowhere at
 * the repo root resolves against that context instead.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param path - Repo-relative path of the Dockerfile.
 * @param allFiles - The full repo inventory, used to validate COPY sources
 *   and entry tokens against real files.
 * @param contextDir - Repo-relative path of the build context (from the
 *   compose service's `build.context`), when it is not the repo root.
 * @returns The inventoried COPY sources and the entry file (null when no
 *   ENTRYPOINT/CMD token names an inventoried file).
 */
export function parseDockerfile(
    repo: string,
    path: string,
    allFiles: readonly string[],
    contextDir?: string | undefined,
): DockerfileShape {
    const text = readText(join(repo, path));
    const inInventory = (p: string) => allFiles.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`));
    const copies = [...text.matchAll(/^COPY\s+([^\s]+)\s/gm)]
        // A COPY source is repo-relative; a leading `./` (immich's convention,
        // `COPY ./server ./server/`) is the same path the inventory records
        // without the prefix, so normalise it before matching.
        .flatMap((m) => {
            const source = m[1]?.replace(/^\.\//, "");
            if (source === undefined) return [];
            if (inInventory(source)) return [source];
            // HC-017: a build context other than the repo root is where the
            // COPY source actually resolves (a service image built from a
            // subdirectory, e.g. immich's machine-learning).
            if (contextDir !== undefined && contextDir !== ".") {
                const inContext = join(contextDir, source);
                if (inInventory(inContext)) return [inContext];
            }
            return [];
        })
        .filter((p) => !p.startsWith("--"));
    // Every ENTRYPOINT/CMD line is considered, in file order: the split form
    // (ENTRYPOINT names the interpreter, CMD names the script) and multi-stage
    // builds both put the interesting token on a later line than the first.
    let entryFile: string | null = null;
    // REVIEW-0010: an image whose ENTRYPOINT/CMD runs a dev server is a dev
    // environment, not a deployment — token-wise, so the exec form
    // (["npm", "run", "dev"]) matches the same as the shell form.
    let devServer: boolean | undefined;
    outer: for (const match of text.matchAll(/^(?:ENTRYPOINT|CMD)\s+(\[.*\]|.+)$/gm)) {
        const entryMatch = match[1];
        if (entryMatch === undefined) continue;
        const parsed = entryMatch.startsWith("[") ? (readJsonSafe(entryMatch) ?? []) : entryMatch.split(/\s+/);
        const tokens = Array.isArray(parsed) ? parsed : [];
        for (const token of tokens) {
            if (typeof token !== "string") continue;
            if (/^(dev|vite|nodemon|storybook)$/.test(token)) {
                devServer = true;
            }
            if (allFiles.includes(token)) {
                entryFile = token;
                break outer;
            }
            // HC-017: an entry token in a non-root context resolves there when
            // it matches nowhere at the repo root.
            if (contextDir !== undefined && contextDir !== ".") {
                const inContext = join(contextDir, token);
                if (allFiles.includes(inContext)) {
                    entryFile = inContext;
                    break outer;
                }
            }
        }
    }
    return { copies, entryFile, devServer };
}
