// Import scanning and resolution: the file/package/room dependency graph
// every later stage consumes (HEURISTICS.md rule S3).

import { dirname, join } from "node:path";
import { owningPackage, type Package } from "./packages.ts";
import { readText } from "./read.ts";
import type { Room } from "./rooms.ts";

type ResolvedImport = { file: string } | { pkg: Package } | { bare: string };

export const IMPORT_PATTERN = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;

export type ImportScan = {
    fileToRoom: Map<string, Room>;
    resolveImport: (fromFile: string, specifier: string) => ResolvedImport | null;
    fileEdges: { from: string; to: string }[];
    packageEdges: Map<string, boolean>;
    bareImports: Map<string, Set<string>>;
    roomEdges: Map<string, number>;
};

/**
 * Scans every source file's import/require specifiers and resolves them:
 * relative and "@/" specifiers to files (NodeNext .js-to-.ts and index
 * resolution included), package names to local packages, anything else bare.
 * Produces file-level edges, cross-package edges, bare-import users, and
 * room-level edge counts.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param packages - The discovered packages, for "@/" alias roots and bare
 *   specifiers naming sibling packages.
 * @param rooms - The room map; only files placed in a room are scanned and
 *   resolvable as import targets.
 * @param sourceFiles - Repo-relative paths of the source files to scan.
 * @returns The file-to-room index, the import resolver, file-level edges,
 *   cross-package edges, bare-import users per specifier, and room-level
 *   edge counts keyed "from->to".
 */
export function scanImports(
    repo: string,
    packages: readonly Package[],
    rooms: Map<string, Room>,
    sourceFiles: readonly string[],
): ImportScan {
    const fileToRoom = new Map<string, Room>();
    for (const room of rooms.values()) for (const f of room.files) fileToRoom.set(f, room);

    /**
     * S3: resolves one import specifier from the importing file — relative
     * and "@/" specifiers to inventoried files, bare specifiers matching a
     * sibling package name to that package, anything else left bare.
     *
     * @param fromFile - Repo-relative path of the importing file.
     * @param specifier - The import/require specifier as written.
     * @returns The resolved file, local package, or bare specifier; null
     *   when a relative or aliased path resolves to nothing inventoried.
     */
    function resolveImport(fromFile: string, specifier: string): ResolvedImport | null {
        /**
         * Tries the raw path against the room index with the usual
         * extension and index-file candidates (NodeNext .js-to-.ts
         * included).
         *
         * @param raw - The repo-relative path to probe.
         * @returns The first inventoried candidate, or null.
         */
        const tryFile = (raw: string): string | null => {
            const candidates = [
                raw,
                `${raw}.ts`,
                `${raw}.tsx`,
                `${raw}.js`,
                `${raw}.mjs`,
                join(raw, "index.ts"),
                join(raw, "index.js"),
            ];
            // NodeNext style: "./foo.js" in source resolves to "./foo.ts" on disk.
            if (/\.m?js$/.test(raw)) candidates.push(raw.replace(/\.m?js$/, ".ts"), raw.replace(/\.m?js$/, ".tsx"));
            for (const candidate of candidates) {
                if (fileToRoom.has(candidate)) return candidate;
            }
            return null;
        };
        if (specifier.startsWith(".")) {
            const hit = tryFile(join(dirname(fromFile), specifier));
            return hit ? { file: hit } : null;
        }
        if (specifier.startsWith("@/")) {
            const pkg = owningPackage(packages, fromFile);
            if (!pkg) return null;
            const hit = tryFile(pkg.dir === "." ? specifier.slice(2) : join(pkg.dir, specifier.slice(2)));
            return hit ? { file: hit } : null;
        }
        const local = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
        if (local) return { pkg: local };
        return { bare: specifier };
    }

    const fileEdges: { from: string; to: string }[] = [];
    const packageEdges = new Map<string, boolean>();
    const bareImports = new Map<string, Set<string>>();

    for (const file of sourceFiles) {
        const fromRoom = fileToRoom.get(file);
        if (!fromRoom) continue;
        const text = readText(join(repo, file));
        for (const match of text.matchAll(IMPORT_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            const target = resolveImport(file, specifier);
            if (!target) continue;
            if ("file" in target) fileEdges.push({ from: file, to: target.file });
            else if ("pkg" in target && target.pkg !== fromRoom.pkg) {
                packageEdges.set(`${fromRoom.pkg.id}->${target.pkg.id}`, true);
            } else if ("bare" in target) {
                let users = bareImports.get(target.bare);
                if (!users) {
                    users = new Set();
                    bareImports.set(target.bare, users);
                }
                users.add(fromRoom.pkg.id);
            }
        }
    }

    const roomEdges = new Map<string, number>();
    for (const { from, to } of fileEdges) {
        const a = fileToRoom.get(from);
        const b = fileToRoom.get(to);
        if (a && b && a !== b) {
            const key = `${a.id}->${b.id}`;
            roomEdges.set(key, (roomEdges.get(key) ?? 0) + 1);
        }
    }

    return { fileToRoom, resolveImport, fileEdges, packageEdges, bareImports, roomEdges };
}
