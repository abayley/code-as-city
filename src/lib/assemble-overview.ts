/**
 * Overview-map assembly (--overview mode). Builds the whole-codebase module
 * overview — every source file a structure, districts by directory or
 * package, banded front-to-back by deployment role — and emits it via the
 * shared map envelope. Rule IDs (O2, O5, O7, O11, C1, D3) refer to
 * HEURISTICS.md.
 */
import { join } from "node:path";
import {
    addOverviewImportEdges,
    assembleInfraDistricts,
    bandOverviewDistricts,
    buildOverviewDistricts,
    emitOverviewModuleNodes,
    inferOverviewDataFlows,
    type OverviewState,
} from "./assemble-overview-phases.ts";
import { linesOf, mermaidId } from "./assembly-helpers.ts";
import { isExcludedCopyDir, normaliseCopyDir } from "./copy-attribution.ts";
import type { Coupling } from "./coupling.ts";
import { emitMap } from "./emit.ts";
import type { HostScanResult } from "./host-config.ts";
import { type Host, isCanonicalComposeFile } from "./hosts.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import { readText } from "./read.ts";
import { type Room, roomDir } from "./rooms.ts";
import type { EmbeddedDatabase, ExternalServiceDep } from "./scans.ts";
import { titleCase } from "./text.ts";
import type { EdgeHost } from "./wrangler.ts";

export type OverviewContext = {
    repo: string;
    outDir: string;
    rooms: Map<string, Room>;
    hosts: readonly Host[];
    candidateHosts: readonly Host[];
    hostScan: readonly HostScanResult[];
    serviceOwner: ReadonlyMap<string, string>;
    hostLayer: Map<string, number>;
    edgeHost: EdgeHost | null;
    drizzleConfig: string | undefined;
    embeddedDatabases: readonly EmbeddedDatabase[];
    externalServiceDeps: readonly ExternalServiceDep[];
    fileEdges: readonly FileEdge[];
    fileCoupling: Map<string, Coupling>;
    fileComplexity: (file: string) => number;
    fileMaxFunctionComplexity: (file: string) => number;
    scriptReferencedFiles: ReadonlySet<string>;
    coverageForFiles: (files: readonly string[]) => number | null;
    docForFiles: (files: readonly string[]) => string | null;
    devToolingWarnings: readonly string[];
    entryDirNames: ReadonlySet<string>;
    dbWritePattern: RegExp;
    dbReadPattern: RegExp;
    dbClientPattern: RegExp;
    scriptReachable: ReadonlySet<string>;
};

/**
 * Overview mode (--overview): a whole-codebase module overview. Districts are
 * directories (or packages in a multi-package repo), every module is a
 * structure, no edges at rest. Composer modules (fan-in 0: CLIs, entries)
 * stand in the front row; supporting modules sit behind, smaller, tagged
 * "support". Migrations collapse to one leaf. Deployment infra and
 * config-declared externals get one district. Height scales with lines of
 * code (unclamped above the minimum); footprint scales with a
 * cyclomatic-complexity approximation (decision-point count).
 * Writes map.json and map.md into outDir.
 *
 * @param context - Everything the overview reads: the repository path and
 *   output directory, the room structure, the resolved deployment shape
 *   (hosts, compose variants, wrangler edge host, drizzle and embedded
 *   databases), the file import graph and coupling, the metric and
 *   documentation lookups, and the entry-dir names and database read/write
 *   patterns used for classification.
 * @returns Resolves once map.json and map.md have been written.
 */
export async function runOverview(context: OverviewContext): Promise<void> {
    const {
        repo,
        outDir,
        rooms,
        hosts,
        candidateHosts,
        hostScan,
        serviceOwner,
        hostLayer,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        externalServiceDeps,
        fileEdges,
        fileCoupling,
        fileComplexity,
        fileMaxFunctionComplexity,
        scriptReferencedFiles,
        coverageForFiles,
        docForFiles,
        devToolingWarnings,
        entryDirNames,
        dbWritePattern,
        dbReadPattern,
        dbClientPattern,
        scriptReachable,
    } = context;
    // District/module colours baked into map.json; keep in step with the
    // viewer's colour vocabulary in viewer/lib/palette.ts.
    const OVERVIEW_APP_COLOR = "#C77740";
    const OVERVIEW_SHARED_COLOR = "#C79F40";
    const OVERVIEW_INFRA_COLOR = "#283B47";
    // .tsx (UI component) modules stand out from plain .ts with their own
    // darker terracotta — distinct from the app terracotta and the shared gold
    // it used to collide with (HC-016).
    const OVERVIEW_TSX_COLOR = "#A15A34";
    /**
     * Reads a source file's text for pattern scans and inference passes.
     *
     * @param file - Repository-relative path of the file to read.
     * @returns The file's contents.
     */
    const fileText = (file: string) => readText(join(repo, file));
    const activeRooms = [...rooms.values()].filter((r) => r.files.length > 0);
    const pkgsWithRooms = [...new Set(activeRooms.map((r) => r.pkg))];
    const multiPkg = pkgsWithRooms.length > 1;

    // Deploy-host attribution: which hosts does a file ship to (via D3 COPY
    // membership of services built from this repo)?
    const copyDirHosts = new Map<string, Set<string>>(); // dir -> Set(host name)
    const activeRoomDirs = activeRooms.map(roomDir);
    for (const host of hosts) {
        for (const service of host.services) {
            if (!service.dockerfile) continue;
            for (const copy of service.copies) {
                const dir = normaliseCopyDir(copy);
                // Skip a COPY coarser than room granularity (O9); the rule lives
                // in copy-attribution.ts, shared with the deployment map's filter.
                if (isExcludedCopyDir(dir, { kind: "coarser-than-room", activeRoomDirs })) continue;
                let dirHosts = copyDirHosts.get(dir);
                if (!dirHosts) {
                    dirHosts = new Set();
                    copyDirHosts.set(dir, dirHosts);
                }
                dirHosts.add(host.name);
            }
        }
    }
    /**
     * Names the deploy hosts a single file ships to, via D3 COPY-directory
     * membership.
     *
     * @param file - Repository-relative source file to attribute.
     * @returns The set of host names whose service images copy the file in.
     */
    const fileHosts = (file: string) => {
        const result = new Set<string>();
        for (const [dir, hostNames] of copyDirHosts) {
            if (file === dir || file.startsWith(`${dir}/`)) for (const name of hostNames) result.add(name);
        }
        return result;
    };
    /**
     * Names the deploy hosts a set of files collectively ships to (the union
     * of fileHosts over the set).
     *
     * @param files - Repository-relative source files, typically a module's
     *   or district's file set.
     * @returns The set of host names any of the files deploy to.
     */
    const filesHosts = (files: readonly string[]) => {
        const result = new Set<string>();
        for (const file of files) for (const name of fileHosts(file)) result.add(name);
        return result;
    };

    // Band order: shared/support strip in front (band 0), then generators,
    // then the host chain, externals behind the last host.
    const SHARED_BAND = 0;
    const PRODUCERS_BAND = 1;
    /**
     * Maps a host to its front-to-back band, after the shared strip and the
     * generators band, in declared forwarding-chain order.
     *
     * @param name - Host name from the deployment shape.
     * @returns The band index for districts deploying to that host.
     */
    const hostBand = (name: string) => 2 + (hostLayer.get(name) ?? 0);
    const maxHostBand = 2 + Math.max(0, ...hostLayer.values());
    const EXTERNALS_BAND = maxHostBand + 1;
    // First host wins a shared band, preferring the canonical topology: a
    // Dockerfile-only image host (HC-018) layers alongside the compose host
    // without joining its forwarding chain, and the band keeps the primary
    // topology's name rather than whichever host the layer map lists last.
    // The canonical set is built once (S3/S4): the comparator below must not
    // reach back into the host list per comparison.
    const canonicalNames = new Set(hosts.filter((host) => isCanonicalComposeFile(host.file)).map((host) => host.name));
    const bandNames = [...hostLayer.keys()].sort(
        (a, b) => Number(!canonicalNames.has(a)) - Number(!canonicalNames.has(b)),
    );
    const hostNameForBand = new Map<number, string>();
    for (const name of bandNames) {
        const band = 2 + (hostLayer.get(name) ?? 0);
        if (!hostNameForBand.has(band)) hostNameForBand.set(band, name);
    }
    /**
     * Human-readable name for a band, used in the band: tags on districts.
     *
     * @param band - Band index (shared strip, generators, a host's band, or
     *   the externals band).
     * @returns The band's display label.
     */
    const bandLabel = (band: number) => {
        if (band === SHARED_BAND) return "Shared & support";
        if (band === PRODUCERS_BAND) return "Generators";
        if (band === EXTERNALS_BAND) return "External systems";
        const hostName = hostNameForBand.get(band);
        return hostName !== undefined ? `${titleCase(hostName)} host` : `Strip ${band}`;
    };

    // These stay local rather than reading the C1 fileCoupling in context: they
    // count EDGES crossing the module's file-set boundary, while
    // couplingFromEdges counts DISTINCT neighbours (Sets) and includes
    // self-edges; multi-file modules (collapsed migrations) also aggregate over
    // a file-set that has no per-module entry in fileCoupling. Not equivalent.
    /**
     * Counts import edges arriving from outside a module's file set.
     *
     * @param files - The module's source files.
     * @returns Number of file-level import edges into the set from files
     *   outside it.
     */
    const externalFanIn = (files: readonly string[]) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(to) && !set.has(from)).length;
    };
    /**
     * Counts import edges leaving a module's file set.
     *
     * @param files - The module's source files.
     * @returns Number of file-level import edges from the set to files
     *   outside it.
     */
    const externalFanOut = (files: readonly string[]) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(from) && !set.has(to)).length;
    };
    /**
     * Classifies a module as shared utility code: fan-in of at least two and
     * instability (fan-out share) at most 0.33 — many importers, few imports.
     * Feeds the shared-code district colouring.
     *
     * @param files - The module's source files.
     * @returns True when the module reads as shared plumbing.
     */
    const moduleIsUtility = (files: readonly string[]) => {
        const fanIn = externalFanIn(files);
        const fanOut = externalFanOut(files);
        return fanIn >= 2 && fanOut / (fanIn + fanOut) <= 0.33;
    };

    const districts = buildOverviewDistricts({ multiPkg, pkgsWithRooms, activeRooms, fileCoupling });

    const overviewNodes: MapNode[] = [];
    const overviewEdges: MapEdge[] = [];
    const allModules: { id: string; files: string[] }[] = []; // for flow-edge classification
    const fileToModule = new Map<string, string>(); // source file -> module node id (for flow edges)

    // The mutable substrate the banding and module-emit phases share.
    const state: OverviewState = {
        overviewNodes,
        allModules,
        fileToModule,
        linesOfFiles: (files) => linesOf(repo, files),
        fileText,
        filesHosts,
        hostBand,
        bandLabel,
        moduleIsUtility,
    };

    // Band each district, then emit its district and module nodes.
    bandOverviewDistricts(districts, state, { producersBand: PRODUCERS_BAND, sharedBand: SHARED_BAND });
    emitOverviewModuleNodes(districts, state, {
        appColor: OVERVIEW_APP_COLOR,
        sharedColor: OVERVIEW_SHARED_COLOR,
        tsxColor: OVERVIEW_TSX_COLOR,
        fileMaxFunctionComplexity,
        fileComplexity,
        docForFiles,
        coverageForFiles,
        scriptReferencedFiles,
        entryDirNames,
    });

    // Infrastructure & external systems: image-only services, config-declared
    // receivers, wrangler/drizzle/embedded databases, and client-SDK externals.
    const uniqueInfra = assembleInfraDistricts({
        overviewNodes,
        overviewEdges,
        hostScan,
        serviceOwner,
        hosts,
        candidateHosts,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        externalServiceDeps,
        fileToModule,
        allModules,
        fileText,
        hostBand,
        bandLabel,
        externalsBand: EXTERNALS_BAND,
        sharedBand: SHARED_BAND,
        infraColor: OVERVIEW_INFRA_COLOR,
    });

    // Remaining data-flow edges: OTLP producers, database reads/writes,
    // embedded-database use, and delivers to referenced externals.
    inferOverviewDataFlows({
        allModules,
        uniqueInfra,
        overviewEdges,
        embeddedDatabases,
        fileText,
        dbWritePattern,
        dbReadPattern,
        dbClientPattern,
        scriptReachable,
    });

    // Import edges, aggregated per module pair (drawn only on selection).
    addOverviewImportEdges({ overviewEdges, fileEdges, fileToModule });

    await emitMap({
        repo,
        outDir,
        nodes: overviewNodes,
        edges: overviewEdges,
        warnings: [
            "Overview mode: orphan exclusion is intentionally skipped; QA-only dev tooling is stripped as in the deployment map.",
            ...devToolingWarnings,
            "Only data-flow edges are shown; import dependencies are omitted by design.",
            "Shared-code districts (>=60% high fan-in / low fan-out modules) are coloured differently.",
            "Complexity is the module's worst single function (McCabe-style decision-point count), not a module-wide sum.",
        ],
        idSuffix: "-overview",
        nameSuffix: " overview",
        summary: "Module overview: every module as a structure, grouped by directory; no dependency edges.",
        /**
         * Renders map.md's body: one mermaid subgraph per district, each
         * module a labelled node with its loc/complexity and source path.
         *
         * @param map - The swept map envelope being emitted.
         * @returns The markdown document body.
         */
        mermaidBody: (map) =>
            [
                `# ${map.name}`,
                "",
                "```mermaid",
                "flowchart TB",
                ...overviewNodes
                    .filter((n) => n.kind === "scope")
                    .flatMap((scope) => [
                        `  subgraph ${mermaidId(scope.id)}["${scope.label}${(scope.description ?? "").startsWith("Shared") ? " (shared code)" : ""}"]`,
                        ...overviewNodes
                            .filter((n) => n.parentId === scope.id)
                            .map(
                                (n) =>
                                    `    ${mermaidId(n.id)}["${n.label}<br/><i>${n.metrics ? `${n.metrics.loc} loc, cx ${n.metrics.complexity}` : n.archetype}</i><br/>${(n.sourceRefs?.[0]?.path ?? "").replace(/"/g, "'")}"]`,
                            ),
                        "  end",
                    ]),
                "```",
            ].join("\n"),
        consoleLines: () => [
            `Wrote ${outDir}/map.json + map.md (overview mode)`,
            `districts=${districts.length + (uniqueInfra.length ? 1 : 0)} nodes=${overviewNodes.length}`,
        ],
    });
}
