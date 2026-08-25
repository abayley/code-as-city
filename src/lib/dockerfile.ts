import { join } from "node:path";
import { readJsonSafe, readText } from "./read.ts";

export type DockerfileShape = {
    copies: string[];
    entryFile: string | null;
};

/**
 * Extracts a Dockerfile's repo-relative COPY sources (only those that exist
 * in the inventory) and its entry file: the first ENTRYPOINT/CMD token that
 * names an inventoried file. Paths are taken repo-relative, matching the
 * monorepo convention of building from the repo root.
 */
export function parseDockerfile(repo: string, path: string, allFiles: readonly string[]): DockerfileShape {
    const text = readText(join(repo, path));
    const copies = [...text.matchAll(/^COPY\s+([^\s]+)\s/gm)]
        .flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
        .filter(
            (p) => !p.startsWith("--") && allFiles.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`)),
        );
    const entryMatch = /^(?:ENTRYPOINT|CMD)\s+(\[.*\]|.+)$/m.exec(text)?.[1];
    let entryFile: string | null = null;
    if (entryMatch !== undefined) {
        const parsed = entryMatch.startsWith("[") ? (readJsonSafe(entryMatch) ?? []) : entryMatch.split(/\s+/);
        const tokens = Array.isArray(parsed) ? parsed : [];
        entryFile = tokens.find((t): t is string => typeof t === "string" && allFiles.includes(t)) ?? null;
    }
    return { copies, entryFile };
}
