import { join, relative, sep } from "node:path";
import { owningPackage, type Package } from "./packages.ts";
import { readText } from "./read.ts";
import { kebab } from "./text.ts";

export type Room = {
    id: string;
    pkg: Package;
    segment: string;
    files: string[];
    loc: number;
};

function segmentsFor(pkg: Package, packages: readonly Package[], sourceFiles: readonly string[]) {
    const locals = sourceFiles
        .filter((f) => owningPackage(packages, f) === pkg)
        .map((f) => (pkg.dir === "." ? f : relative(pkg.dir, f)));
    const byFirst = new Map<string, number>();
    for (const local of locals) {
        const first = local.includes(sep) ? (local.split(sep)[0] ?? "(root)") : "(root)";
        byFirst.set(first, (byFirst.get(first) ?? 0) + 1);
    }
    const dominant = [...byFirst.entries()].find(
        ([seg, count]) =>
            seg !== "(root)" &&
            count / locals.length > 0.6 &&
            locals.some((l) => l.startsWith(seg + sep) && l.split(sep).length > 2),
    );
    return { dominant: dominant?.[0] ?? null };
}

/**
 * Groups source files into rooms. Room key = first path segment within the
 * package; a dominant segment holding most of the package's files (e.g. src/)
 * is expanded one level deeper. Rooms are mutable downstream (dev-tooling
 * stripping rewrites files and loc).
 */
export function buildRooms(
    repo: string,
    packages: readonly Package[],
    sourceFiles: readonly string[],
): Map<string, Room> {
    const packageSegmentation = new Map(packages.map((pkg) => [pkg, segmentsFor(pkg, packages, sourceFiles)]));
    const rooms = new Map<string, Room>();
    for (const file of sourceFiles) {
        const pkg = owningPackage(packages, file);
        if (!pkg) continue;
        const local = pkg.dir === "." ? file : relative(pkg.dir, file);
        const parts = local.split(sep);
        const dominant = packageSegmentation.get(pkg)?.dominant ?? null;
        let segment: string;
        const first = parts[0];
        const second = parts[1];
        if (parts.length === 1 || first === undefined) segment = "(root)";
        else if (first === dominant && parts.length > 2 && second !== undefined) segment = join(first, second);
        else segment = first;
        const id = `${pkg.id}-${kebab(segment)}`;
        let room = rooms.get(id);
        if (!room) {
            room = { id, pkg, segment, files: [], loc: 0 };
            rooms.set(id, room);
        }
        room.files.push(file);
        room.loc += readText(join(repo, file)).split("\n").length;
    }
    return rooms;
}
