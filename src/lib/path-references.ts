import { dirname, join, sep } from "node:path";
import { IMPORT_PATTERN } from "./imports.ts";
import { owningPackage, type Package } from "./packages.ts";
import { readText } from "./read.ts";
import type { Room } from "./rooms.ts";

export type PathReassignment = { pkg: Package | null; fromFile: string };

/**
 * R4: a string literal in one package's code that resolves into another
 * area's directory (e.g. the CLI bundling "../../skills/map-codebase") is a
 * declared dependency: the referenced area is reassigned to the referencing
 * package's district. Plain relative imports are ordinary dependencies (S3
 * edges), not area claims — only non-import path literals reassign. The
 * literal may be relative to the file's directory or to the package root
 * (the resolve(packageRoot, "...") idiom): both bases are tried.
 */
export function findPathReassignments(
    repo: string,
    packages: readonly Package[],
    rooms: ReadonlyMap<string, Room>,
    sourceFiles: readonly string[],
): Map<string, PathReassignment> {
    const pathReassignments = new Map<string, PathReassignment>();
    for (const file of sourceFiles) {
        const text = readText(join(repo, file));
        const fromPkg = owningPackage(packages, file);
        const importSpecifiers = new Set([...text.matchAll(IMPORT_PATTERN)].map((m) => m[1]));
        for (const match of text.matchAll(/["']((?:\.\.\/)+[^"'\n]+)["']/g)) {
            const literal = match[1];
            if (literal === undefined || importSpecifiers.has(literal)) continue;
            const bases = [dirname(file), fromPkg?.dir ?? "."];
            for (const base of bases) {
                const resolved = join(base === "." ? "" : base, literal);
                if (resolved.startsWith("..")) continue;
                for (const room of rooms.values()) {
                    if (room.pkg === fromPkg || room.segment === "(root)") continue;
                    const segDir = room.pkg.dir === "." ? room.segment : join(room.pkg.dir, room.segment);
                    if ((resolved === segDir || resolved.startsWith(segDir + sep)) && !pathReassignments.has(room.id)) {
                        pathReassignments.set(room.id, { pkg: fromPkg, fromFile: file });
                    }
                }
            }
        }
    }
    return pathReassignments;
}
