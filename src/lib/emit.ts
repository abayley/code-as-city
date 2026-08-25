import { writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { COUPLING_THRESHOLDS, type Coupling, type CouplingAnalysis } from "./coupling.ts";
import type { CrontabSchedule } from "./crontab.ts";
import type { Host } from "./hosts.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import type { Package } from "./packages.ts";
import { type Room, roomDir } from "./rooms.ts";
import { kebab, titleCase } from "./text.ts";
import type { EdgeHost } from "./wrangler.ts";

export type EmitContext = {
    repo: string;
    outDir: string;
    nodes: MapNode[];
    edges: MapEdge[];
    warnings: string[];
    rooms: Map<string, Room>;
    packages: readonly Package[];
    hosts: readonly Host[];
    crontabFiles: readonly string[];
    edgeHost: EdgeHost | null;
    drizzleConfig: string | undefined;
    schedules: ReadonlyMap<string, CrontabSchedule>;
    roomEdges: ReadonlyMap<string, number>;
    roomCoupling: Map<string, Coupling>;
    fileCoupling: Map<string, Coupling>;
    fileEdges: readonly FileEdge[];
    eliminatedRooms: CouplingAnalysis["eliminatedRooms"];
};

/**
 * Section 8 of the generator: emits map.json plus the intermediate artefacts
 * (deploy shape, dependency graphs, coupling, mermaid views) into outDir and
 * prints the final console summary.
 */
export async function emitArtefacts(context: EmitContext): Promise<void> {
    const {
        repo,
        outDir,
        nodes,
        edges,
        warnings,
        rooms,
        packages,
        hosts,
        crontabFiles,
        edgeHost,
        drizzleConfig,
        schedules,
        roomEdges,
        roomCoupling,
        fileCoupling,
        fileEdges,
        eliminatedRooms,
    } = context;

    // Final sweep: an edge may have been declared from a room that a later rule
    // excluded (dev tooling, orphan); drop any edge with a missing endpoint.
    const finalNodeIds = new Set(nodes.map((n) => n.id));
    const finalEdges = edges.filter((e) => finalNodeIds.has(e.from) && finalNodeIds.has(e.to));

    const map = {
        schemaVersion: 1,
        id: kebab(basename(repo)),
        name: titleCase(basename(repo)),
        repository: repo,
        summary: "Deterministic draft map generated without an agent (prototype).",
        generatedAt: new Date().toISOString(),
        nodes,
        edges: finalEdges,
        warnings,
    };

    const deployShape = {
        hosts: hosts.map((h) => ({
            file: h.file,
            name: h.name,
            services: h.services.map(
                ({ name, image, dockerfile, entryFile, copies, schedule, hasPorts, imageClass }) => ({
                    name,
                    image,
                    dockerfile,
                    entryFile,
                    copies,
                    schedule,
                    hasPorts,
                    imageClass,
                }),
            ),
        })),
        crontabs: crontabFiles,
        wrangler: edgeHost,
        drizzle: drizzleConfig ?? null,
    };

    const roomEdgeList = [...roomEdges.entries()].map(([key, count]) => {
        const [from, to] = key.split("->");
        if (from === undefined || to === undefined) throw new Error(`Malformed room edge key: ${key}`);
        return { from, to, imports: count };
    });
    const dot = [
        "digraph rooms {",
        '  rankdir=LR; node [shape=box, fontname="Helvetica"];',
        ...[...rooms.values()]
            .filter((r) => r.files.length)
            .map((r) => `  "${r.id}" [label="${r.pkg.id}\\n${r.segment} (${r.files.length}f)"];`),
        ...roomEdgeList.map((e) => `  "${e.from}" -> "${e.to}" [label="${e.imports}"];`),
        "}",
    ].join("\n");

    // Mermaid views of the result, for following the mapping rules by eye.
    function mermaidId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_]/g, "_");
    }
    function mermaidLabel(text: string): string {
        return text.replace(/"/g, "'");
    }
    const isCampus = (n: MapNode) =>
        n.kind !== "scope" && (!n.parentId || nodes.some((s) => s.id === n.parentId && s.kind === "scope"));
    const nodePath = (n: MapNode): string | undefined => {
        const paths = (n.sourceRefs ?? []).map((ref) => ref.path).filter(Boolean);
        return paths.length ? paths.slice(0, 2).join(", ") + (paths.length > 2 ? ", …" : "") : undefined;
    };
    const campusNodeLine = (n: MapNode, indent: string, extra = "") => {
        const path = nodePath(n);
        return `${indent}${mermaidId(n.id)}["${mermaidLabel(n.label)}<br/><i>${n.archetype}${extra}</i>${path ? `<br/>${mermaidLabel(path)}` : ""}"]`;
    };
    // A building with rooms renders as a nested subgraph so interiors are visible.
    const campusNodeLines = (n: MapNode, indent: string, extra = ""): string[] => {
        const roomsOf = nodes.filter((r) => r.parentId === n.id);
        if (!roomsOf.length) return [campusNodeLine(n, indent, extra)];
        const path = nodePath(n);
        return [
            `${indent}subgraph ${mermaidId(n.id)}["${mermaidLabel(n.label)} <i>(${n.archetype}${extra})</i>${path ? `<br/>${mermaidLabel(path)}` : ""}"]`,
            ...roomsOf.map((r) => campusNodeLine(r, `${indent}  `)),
            `${indent}end`,
        ];
    };
    const renderedIds = new Set(nodes.filter((n) => n.kind !== "scope").map((n) => n.id));
    const mapMermaid = [
        "```mermaid",
        "flowchart TB",
        ...nodes
            .filter((n) => n.kind === "scope")
            .flatMap((scope) => [
                `  subgraph ${mermaidId(scope.id)}["${mermaidLabel(scope.label)}"]`,
                ...nodes.filter((n) => n.parentId === scope.id).flatMap((n) => campusNodeLines(n, "    ")),
                "  end",
            ]),
        ...nodes.filter((n) => isCampus(n) && !n.parentId).flatMap((n) => campusNodeLines(n, "  ", ", no district")),
        ...finalEdges
            .filter((e) => renderedIds.has(e.from) && renderedIds.has(e.to))
            .map((e) => {
                const label = mermaidLabel(e.label ?? e.kind);
                const arrow =
                    e.kind === "data_flow"
                        ? `-. "${label}" .->`
                        : e.kind === "deploys"
                          ? `== "${label}" ==>`
                          : `-- "${label}" -->`;
                return `  ${mermaidId(e.from)} ${arrow} ${mermaidId(e.to)}`;
            }),
        "```",
    ].join("\n");

    // Breakdown of the eliminated shared utility dirs: the modules inside each
    // (subdirs and standalone files), with per-module coupling and the import
    // edges among them.
    let sharedBreakdown: string | null = null;
    if (eliminatedRooms.length) {
        const roomById = (id: string): Room => {
            const room = rooms.get(id);
            if (!room) throw new Error(`Eliminated room missing from rooms: ${id}`);
            return room;
        };
        const memberFiles = new Set(eliminatedRooms.flatMap((r) => roomById(r.id).files));
        const fileLine = (room: Room, file: string) => {
            const local = relative(roomDir(room), file).replace(/\.[a-z]+$/, "");
            const c = fileCoupling.get(file);
            return `    ${mermaidId(file)}["${mermaidLabel(local)}<br/><i>in=${c?.in ?? 0} out=${c?.out ?? 0}</i>"]`;
        };
        const interiorEdges = fileEdges.filter(({ from, to }) => memberFiles.has(from) && memberFiles.has(to));
        sharedBreakdown = [
            "# Shared utility modules: interior breakdown",
            "",
            "Every file in the eliminated shared dirs is a module here; in/out counts",
            "are repository-wide file coupling. Edges are imports within/between the",
            "shared dirs.",
            "",
            "```mermaid",
            "flowchart LR",
            ...eliminatedRooms.flatMap((r) => {
                const room = roomById(r.id);
                return [
                    `  subgraph ${mermaidId(r.id)}["${mermaidLabel(roomDir(room))}/"]`,
                    ...room.files.map((file) => fileLine(room, file)),
                    "  end",
                ];
            }),
            ...interiorEdges.map(({ from, to }) => `  ${mermaidId(from)} --> ${mermaidId(to)}`),
            "```",
        ].join("\n");
    }

    const roomsMermaid = [
        "```mermaid",
        "flowchart LR",
        ...packages.flatMap((pkg) => {
            const pkgRoomList = [...rooms.values()].filter((r) => r.pkg === pkg && r.files.length);
            if (!pkgRoomList.length) return [];
            const pkgPath = pkg.dir === "." ? "(repository root)" : `${pkg.dir}/`;
            return [
                `  subgraph ${mermaidId(pkg.id)}["${mermaidLabel(pkg.name)}<br/>${mermaidLabel(pkgPath)}"]`,
                ...pkgRoomList.map((r) => {
                    const c = roomCoupling.get(r.id);
                    const coupled = c ? ` in=${c.in} out=${c.out}` : "";
                    const roomPath =
                        r.segment === "(root)" ? pkgPath : `${pkg.dir === "." ? "" : `${pkg.dir}/`}${r.segment}/`;
                    return `    ${mermaidId(r.id)}["${mermaidLabel(roomPath)}<br/><i>${r.files.length} files${coupled}</i>"]`;
                }),
                "  end",
            ];
        }),
        ...roomEdgeList.map((e) => `  ${mermaidId(e.from)} -- "${e.imports}" --> ${mermaidId(e.to)}`),
        "```",
    ].join("\n");

    const coupling = {
        thresholds: { ...COUPLING_THRESHOLDS },
        eliminatedRooms,
        rooms: [...roomCoupling.entries()]
            .map(([id, c]) => ({ id, ...c, instability: Number(c.instability.toFixed(2)) }))
            .sort((a, b) => b.in + b.out - (a.in + a.out)),
        files: [...fileCoupling.entries()]
            .map(([file, c]) => ({ file, ...c, instability: Number(c.instability.toFixed(2)) }))
            .sort((a, b) => b.in + b.out - (a.in + a.out))
            .slice(0, 200),
    };

    await Promise.all([
        writeFile(join(outDir, "map.json"), `${JSON.stringify(map, null, 2)}\n`),
        writeFile(join(outDir, "deploy-shape.json"), `${JSON.stringify(deployShape, null, 2)}\n`),
        writeFile(join(outDir, "deps-files.json"), `${JSON.stringify(fileEdges, null, 2)}\n`),
        writeFile(join(outDir, "deps-rooms.json"), `${JSON.stringify(roomEdgeList, null, 2)}\n`),
        writeFile(join(outDir, "deps-rooms.dot"), `${dot}\n`),
        writeFile(join(outDir, "map.md"), `# ${map.name}: generated map\n\n${mapMermaid}\n`),
        ...(sharedBreakdown ? [writeFile(join(outDir, "shared-libraries.md"), `${sharedBreakdown}\n`)] : []),
        writeFile(join(outDir, "deps-rooms.md"), `# ${map.name}: room-level import graph\n\n${roomsMermaid}\n`),
        writeFile(join(outDir, "coupling.json"), `${JSON.stringify(coupling, null, 2)}\n`),
    ]);

    console.log(
        `Wrote ${outDir}/{map,deploy-shape,deps-files,deps-rooms,coupling}.json + deps-rooms.dot + {map,deps-rooms}.md`,
    );
    console.log(
        `nodes=${nodes.length} edges=${edges.length} hosts=${hosts.length} scheduled=${schedules.size} eliminated=${eliminatedRooms.length}`,
    );
}
