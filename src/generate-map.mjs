#!/usr/bin/env node

// Deterministic (agent-free) Functionary city map generator. Being extracted
// into typed modules under src/lib/ per HEURISTICS.md rule group; see
// docs/rfc-0001-generator-extraction.md.
//
// Usage: bun src/generate-map.mjs <target-repo> [--out-dir out/<name>]
// Outputs: map.json, deploy-shape.json, deps-files.json, deps-rooms.json, deps-rooms.dot

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseArguments, USAGE } from "./lib/arguments.ts";
import { runOverview } from "./lib/assemble-overview.ts";
import { createComplexityScanner } from "./lib/complexity.ts";
import { analyseCoupling, COUPLING_THRESHOLDS } from "./lib/coupling.ts";
import { parseCrontabSchedules } from "./lib/crontab.ts";
import { layerByLongestPath } from "./lib/flow.ts";
import { layerHosts, scanHostConfigs } from "./lib/host-config.ts";
import { buildHosts } from "./lib/hosts.ts";
import { IMPORT_PATTERN, scanImports } from "./lib/imports.ts";
import { ENTRY_FILE_PATTERN, extensionOf, inventory, isTestPath, SOURCE_EXTENSIONS } from "./lib/inventory.ts";
import { discoverPackages, owningPackage as owningPackageOf, packageDirsOf } from "./lib/packages.ts";
import { findPathReassignments } from "./lib/path-references.ts";
import { analyseReachability, stripDevTooling } from "./lib/reachability.ts";
import { readJson, readText } from "./lib/read.ts";
import { buildRooms, roomDir } from "./lib/rooms.ts";
import { createDocScanner, findEmbeddedDatabases, OTLP_PATTERN, scanCoverage } from "./lib/scans.ts";
import { kebab, titleCase } from "./lib/text.ts";
import { scanCiWorkflows } from "./lib/workflows.ts";
import { findEdgeHost } from "./lib/wrangler.ts";

const ENTRY_DIR_NAMES = new Set(["bin", "app", "pages", "routes", "cmd", "cli", "api"]);

const parsedArguments = parseArguments(process.argv.slice(2));
if (!parsedArguments) {
    console.error(USAGE);
    process.exit(2);
}
const { repo, outDir, modulesAsBuildings, overview } = parsedArguments;

// Experimental (--modules-as-buildings): every module node with >=2 files
// becomes a building whose rooms are its files — a preview of "buildings
// depict modules" while the room semantics are still undecided.
// Kebab-flattened ids can collide across mechanisms (the file src/node.ts and
// the room src/node/ both yield ...-src-node): suffix until free, checking
// both emitted nodes and the room-id namespace still to be emitted.
function uniqueNodeId(base) {
    let id = base;
    for (let n = 2; rooms.has(id) || nodes.some((x) => x.id === id); n += 1) id = `${base}-${n}`;
    return id;
}

function pushFileRooms(parentId, files) {
    for (const file of files) {
        const name = basename(file).replace(/\.[a-z]+$/, "");
        nodes.push({
            id: uniqueNodeId(kebab(`${parentId}-${name}`)),
            label: titleCase(name),
            kind: "module",
            archetype: "room",
            parentId,
            description: `Source file ${file}.`,
            sourceRefs: [{ path: file }],
        });
    }
}
mkdirSync(outDir, { recursive: true });

// --- 1. Inventory --------------------------------------------------------------

const allFiles = inventory(repo);
// Tool configuration written in a code extension is config, not code:
// vite.config.ts, marp.config.mjs, vitest-setup.ts, .eslintrc.js, ...
const CONFIG_FILE_PATTERN =
    /(?:^|\/)(?:[\w.-]*\.config\.(?:ts|js|mjs|cjs)|[\w.-]*-setup\.(?:ts|js|mjs)|\.\w+rc\.(?:js|cjs))$/;
const sourceFiles = allFiles.filter(
    (f) =>
        SOURCE_EXTENSIONS.has(extensionOf(f)) && !isTestPath(f) && !CONFIG_FILE_PATTERN.test(f) && !/\.d\.ts$/.test(f),
);

// --- 2. Packages ----------------------------------------------------------------

const packageDirs = packageDirsOf(allFiles);
const packages = discoverPackages(repo, packageDirs);
const owningPackage = (file) => owningPackageOf(packages, file);

// --- 3. Rooms -------------------------------------------------------------------
const rooms = buildRooms(repo, packages, sourceFiles);

// --- 4. Import scan ---------------------------------------------------------------

const { fileToRoom, resolveImport, fileEdges, packageEdges, bareImports, roomEdges } = scanImports(
    repo,
    packages,
    rooms,
    sourceFiles,
);

// --- 4b. Coupling metrics (archunitts-style fan-in/fan-out/instability) -----------
// Utility modules (high fan-in, low fan-out, instability -> 0) are shared
// lib-like leaves: eliminated from the map so buildings keep only their
// coordinator/composer rooms. Coordinators (low in, high out) are retained.

// Method-call forms require a database-ish receiver: bare .delete()/.update()
// would match every JavaScript Map and Set.
const DB_WRITE_PATTERN =
    /insert\s+into\s|delete\s+from\s|\bupdate\s+\w+\s+set\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.(?:insert|update|delete|upsert)\s*\(/i;
const DB_READ_PATTERN =
    /\bselect\s[\s\S]{0,80}?\bfrom\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.select\s*\(/i;

const { fileComplexity, fileMaxFunctionComplexity } = createComplexityScanner(repo);

const { fileCoupling, roomCoupling, isMidFile, isUtilityRoom, eliminatedRooms } = analyseCoupling(
    fileEdges,
    roomEdges,
    rooms,
);

// --- 5. Deployment shape -----------------------------------------------------------

function fileExists(p) {
    return allFiles.includes(p);
}

const composeFiles = allFiles.filter((f) => /docker-compose[^/]*\.(yml|yaml)$/.test(basename(f)));
const crontabFiles = allFiles.filter((f) => /^crontab/.test(basename(f)));
const schedules = parseCrontabSchedules(crontabFiles.map((f) => [f, readText(join(repo, f))]));

const { hosts, candidateHosts, serviceDependsOn } = buildHosts(repo, allFiles, composeFiles, schedules);

// Wrangler -> an edge host.
const edgeHost = findEdgeHost(repo, allFiles);

const drizzleConfig = allFiles.find((f) => /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f));

const embeddedDatabases = findEmbeddedDatabases(packages);

const ciWorkflows = scanCiWorkflows(repo, allFiles);

const hostScan = scanHostConfigs(repo, allFiles, hosts);
const hostLayer = layerHosts(hostScan, hosts);

const { coverageForFiles } = scanCoverage(repo, packageDirs);
const { fileDocSummary, docForFiles } = createDocScanner(repo);

// --- 6b. Dev-tooling detection by reachability ----------------------------------------

const reachability = analyseReachability(repo, packages, hosts, edgeHost, sourceFiles, fileEdges, fileToRoom);
const { deployReachable, scriptReachable, scriptReferencedFiles } = reachability;
const devToolingWarnings = stripDevTooling(repo, rooms, reachability, fileEdges);

// --- Overview mode (--overview) ------------------------------------------------
// A whole-codebase module overview: districts are directories (or packages in
// a multi-package repo), every module is a structure, no edges. Composer
// modules (fan-in 0: CLIs, entries) stand in the front row; supporting
// modules sit behind, smaller, tagged "support". Migrations collapse to one
// leaf. Deployment infra and config-declared externals get one district.
// Height scales with lines of code (unclamped above the minimum); footprint
// scales with a cyclomatic-complexity approximation (decision-point count).
if (overview) {
    await runOverview({
        repo,
        outDir,
        rooms,
        hosts,
        candidateHosts,
        hostScan,
        hostLayer,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        fileEdges,
        fileCoupling,
        fileComplexity,
        fileMaxFunctionComplexity,
        scriptReferencedFiles,
        coverageForFiles,
        docForFiles,
        devToolingWarnings,
        entryDirNames: ENTRY_DIR_NAMES,
        dbWritePattern: DB_WRITE_PATTERN,
        dbReadPattern: DB_READ_PATTERN,
    });
    process.exit(0);
}

// --- 6c. Cross-package path references --------------------------------------------
const pathReassignments = findPathReassignments(repo, packages, rooms, sourceFiles);

// --- 7. Assemble the map --------------------------------------------------------------

const nodes = [];
const edges = [];
const warnings = [
    "Generated by the deterministic prototype: names and descriptions are mechanical, not semantic.",
    "Test directories and *.test/*.spec files are excluded.",
    `Shared utility modules (fan-in >= ${COUPLING_THRESHOLDS.utilityMinFanIn}, instability <= ${COUPLING_THRESHOLDS.utilityMaxInstability}) are eliminated: ${eliminatedRooms.map((r) => r.segment).join(", ") || "none"}.`,
    ...devToolingWarnings,
];
const claimedSegments = new Set(); // source dirs claimed by a deployed service
const serviceClaimedDirs = new Set(); // subset claimed by compose services (not wrangler)
const campusFileSets = []; // campus node id -> the source files it runs (for I/O classification)
const fileNodeOwner = new Map(); // source file -> emitted campus node id (for shared-lib edges)

function addEdge(edge) {
    if (edges.some((e) => e.id === edge.id)) return;
    edges.push(edge);
}

// 7a. Host districts from deployment shape. Hosts carry explicit flow layers
// from the declared forwarding chain (gateway before stack before evaluation)
// with a large base, so they always sit behind the code districts and edge
// cycles (evaluation <-> bootstrap) cannot scramble their order.
const HOST_LAYER_BASE = 1000;
// Externals are their own systems, not tenants of whichever host's config
// mentions them: they share one district behind the host chain (as overview
// mode's O7 does).
const EXTERNALS_DISTRICT_ID = "external-systems";
const ensureExternalsDistrict = () => {
    if (!nodes.some((n) => n.id === EXTERNALS_DISTRICT_ID)) {
        nodes.push({
            id: EXTERNALS_DISTRICT_ID,
            label: "External systems",
            kind: "scope",
            archetype: "district",
            description: "Externally hosted systems this deployment exchanges data with.",
            display: { flowLayer: HOST_LAYER_BASE + 500 },
        });
    }
    return EXTERNALS_DISTRICT_ID;
};
for (const host of hosts) {
    nodes.push({
        id: host.id,
        label: `${titleCase(host.name)} host`,
        kind: "scope",
        archetype: "district",
        description: `Deployment host projected from ${host.file}.`,
        display: { flowLayer: HOST_LAYER_BASE + (hostLayer.get(host.name) ?? 0) },
    });
    for (const service of host.services) {
        const serviceId = kebab(`${host.id}-${service.name}`);
        const allCopiedSegments = service.copies
            .map((copy) => copy.replace(/\/$/, ""))
            .filter((copy) => copy.includes("/") || rooms.has(`${owningPackage(copy)?.id}-${kebab(copy)}`));
        // Coupling filter: drop shared lib-like dirs (high fan-in, low fan-out).
        const roomIdForCopy = (copy) => {
            const sample = sourceFiles.find((f) => f.startsWith(`${copy}/`));
            return sample ? fileToRoom.get(sample)?.id : null;
        };
        const copiedSegments = allCopiedSegments.filter((copy) => {
            if (basename(copy) === "lib") return false; // shared plumbing, not shape
            const roomId = roomIdForCopy(copy);
            return !(roomId && isUtilityRoom(roomId));
        });
        for (const copy of allCopiedSegments) {
            claimedSegments.add(copy);
            serviceClaimedDirs.add(copy);
        }
        const serviceSourceFiles = [];
        for (const copy of copiedSegments) {
            for (const f of sourceFiles)
                if (f.startsWith(`${copy}/`)) {
                    fileNodeOwner.set(f, serviceId);
                    serviceSourceFiles.push(f);
                }
        }
        campusFileSets.push({ id: serviceId, files: serviceSourceFiles, entryFile: service.entryFile });
        const isScheduled = Boolean(service.schedule);
        const roomsForService = copiedSegments.length >= 2;
        const archetype = roomsForService
            ? "building"
            : (service.imageClass ?? (isScheduled ? "worker" : service.hasPorts ? "gateway" : "worker"));
        const flowLayer =
            service.imageClass === "database" || service.imageClass === "queue" || service.imageClass === "storage"
                ? 2
                : service.hasPorts && !service.dockerfile
                  ? 0
                  : isScheduled
                    ? 1
                    : service.dockerfile
                      ? 1
                      : 1;
        // A service whose entrypoint is a *-command file is labelled by that
        // command (Delivery Command, not the compose service name delivery-worker).
        const entryName = service.entryFile ? basename(service.entryFile).replace(/\.[a-z]+$/, "") : null;
        nodes.push({
            id: serviceId,
            label: titleCase(entryName?.endsWith("-command") ? entryName : service.name),
            kind: service.dockerfile ? "deployable" : "infra",
            archetype,
            parentId: host.id,
            // Prose (TSDoc, prepended in 7f) plus the schedule as its own
            // paragraph; build/entry provenance moves to labelled attributes
            // rendered in the Source files section.
            description: [
                service.dockerfile ? null : `Container image ${service.image ?? "unknown"}.`,
                service.schedule ? `Scheduled job: ${service.schedule}` : null,
            ]
                .filter(Boolean)
                .join("\n\n"),
            attributes: {
                ...(service.dockerfile ? { "service-source": service.dockerfile } : {}),
                ...(service.entryFile ? { "entry-point": service.entryFile } : {}),
            },
            sourceRefs: [{ path: service.dockerfile ?? host.file }],
            ...(serviceSourceFiles.length
                ? {
                      metrics: {
                          loc: serviceSourceFiles.reduce(
                              (sum, f) => sum + readText(join(repo, f)).split("\n").length,
                              0,
                          ),
                      },
                  }
                : {}),
            tags: [isScheduled ? "cron" : null, service.hasPorts ? "listens" : null].filter(Boolean),
            display: { flowLayer },
        });
        // Rooms: one per source directory the image copies in.
        if (roomsForService) {
            const roomIds = [];
            const localEdges = new Map();
            for (const copy of copiedSegments) {
                const roomId = kebab(`${serviceId}-${copy}`);
                roomIds.push(roomId);
                const loc = sourceFiles.filter((f) => f.startsWith(`${copy}/`)).length;
                nodes.push({
                    id: roomId,
                    label: titleCase(basename(copy)),
                    kind: "module",
                    archetype: "room",
                    parentId: serviceId,
                    description: `Source copied from ${copy}/ into the ${service.name} image.`,
                    sourceRefs: [{ path: copy }],
                    metrics: { loc },
                });
            }
            // Local flow: entry dir first, then longest path over dir-level imports.
            for (const { from, to } of fileEdges) {
                const a = copiedSegments.find((c) => from.startsWith(`${c}/`));
                const b = copiedSegments.find((c) => to.startsWith(`${c}/`));
                if (a && b && a !== b)
                    localEdges.set(`${kebab(`${serviceId}-${a}`)}->${kebab(`${serviceId}-${b}`)}`, true);
            }
            const entryDir = service.entryFile
                ? copiedSegments.find((c) => service.entryFile.startsWith(`${c}/`))
                : null;
            const layers = layerByLongestPath(roomIds, localEdges, entryDir ? [kebab(`${serviceId}-${entryDir}`)] : []);
            for (const roomId of roomIds) {
                nodes.find((n) => n.id === roomId).display = { flowLayer: layers.get(roomId) ?? 0 };
            }
            for (const key of localEdges.keys()) {
                const [from, to] = key.split("->");
                addEdge({ id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared" });
            }
        }
    }
}

// 7a-ii. Service wiring from depends_on (harvested across compose variants).
// A dependency that only exists in a deduped variant (e.g. the development
// compose runs the database locally) is carried onto the surviving host as
// infra when its image classifies as one.
const variantServices = new Map();
for (const candidate of candidateHosts) {
    for (const service of candidate.services) {
        if (service.imageClass && !variantServices.has(service.name)) variantServices.set(service.name, service);
    }
}
for (const host of hosts) {
    for (const service of host.services) {
        const deps = serviceDependsOn.get(service.name);
        if (!deps) continue;
        const fromId = kebab(`${host.id}-${service.name}`);
        if (!nodes.some((n) => n.id === fromId)) continue;
        for (const dep of deps) {
            const toId = kebab(`${host.id}-${dep}`);
            if (!nodes.some((n) => n.id === toId)) {
                const variant = variantServices.get(dep);
                if (!variant) continue;
                nodes.push({
                    id: toId,
                    label: titleCase(dep),
                    kind: "infra",
                    archetype: variant.imageClass,
                    parentId: host.id,
                    description: `Backing service (image ${variant.image}) declared in a compose variant; the deployed host provides it via configuration.`,
                    sourceRefs: [{ path: host.file }],
                    display: { flowLayer: 2 },
                });
            }
            addEdge({
                id: `${fromId}--${toId}`,
                from: fromId,
                to: toId,
                kind: "depends_on",
                evidence: "declared",
                label: "compose depends_on",
            });
        }
    }
}

// 7a-iii. Host forwarding: a host's own config file declaring an exporter
// endpoint that names another host (e.g. the collector gateway's
// STACK_OTLP_ENDPOINT) links the two hosts' primary services with data_flow.
function primaryServiceId(host) {
    const preferred = host.services.find((s) => /collector|gateway|ingest/.test(s.name)) ?? host.services[0];
    return preferred ? kebab(`${host.id}-${preferred.name}`) : null;
}
for (const host of hosts) {
    const hostDir = dirname(host.file);
    const hostTokens = host.name.split(" ").filter(Boolean);
    const ownConfigs = allFiles.filter(
        (f) =>
            dirname(f) === hostDir &&
            /\.ya?ml$/.test(f) &&
            !/docker-compose/.test(basename(f)) &&
            hostTokens.some((token) => basename(f).includes(token)),
    );
    for (const config of ownConfigs) {
        // Exporter-ish lines only: endpoints and env-var references.
        const exportLines = readText(join(repo, config))
            .split("\n")
            .filter((line) => /endpoint:|\$\{env:/.test(line))
            .map((line) => line.toLowerCase().replace(/[^a-z0-9]/g, ""));
        const from = primaryServiceId(host);
        if (!from || !nodes.some((n) => n.id === from)) continue;
        for (const other of hosts) {
            if (other === host) continue;
            // Host-name match (the gateway's STACK_OTLP_ENDPOINT names the stack).
            const distinct = other.name
                .split(" ")
                .filter((token) => token && !hostTokens.includes(token))
                .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""));
            if (distinct.length && exportLines.some((line) => distinct.some((token) => line.includes(token)))) {
                const to = primaryServiceId(other);
                if (to && nodes.some((n) => n.id === to)) {
                    addEdge({
                        id: `${from}--${to}`,
                        from,
                        to,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: config }],
                    });
                }
            }
            // Service-name match (the stack's SPAN_INGEST_BEARER_TOKEN names the
            // span-ingest service on the evaluation host).
            for (const service of other.services) {
                const normalised = service.name.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (normalised.length < 6) continue;
                if (!exportLines.some((line) => line.includes(normalised))) continue;
                const to = kebab(`${other.id}-${service.name}`);
                if (nodes.some((n) => n.id === to)) {
                    addEdge({
                        id: `${from}--${to}`,
                        from,
                        to,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: config }],
                    });
                }
            }
        }
        // Exporter endpoints whose env token names nothing internal are external
        // systems: LANGFUSE_OTLP_ENDPOINT -> a Langfuse external node.
        const internalNames = new Set(
            [...hosts.flatMap((h) => h.name.split(" ")), ...hosts.flatMap((h) => h.services.map((s) => s.name))]
                .map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""))
                .filter(Boolean),
        );
        const rawLines = readText(join(repo, config)).split("\n");
        rawLines.forEach((line, index) => {
            const envToken = /endpoint:.*\$\{env:([A-Z0-9_]+)\}/.exec(line)?.[1];
            if (!envToken) return;
            // Skip when the surrounding exporter block names something internal
            // (the span store exporter carries a SPAN_INGEST bearer header).
            const windowText = rawLines
                .slice(Math.max(0, index - 4), index + 5)
                .join(" ")
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
            if ([...internalNames].some((name) => name.length >= 4 && windowText.includes(name))) return;
            const candidate = envToken
                .split("_")
                .filter(
                    (word) =>
                        ![
                            "OTLP",
                            "HTTP",
                            "GRPC",
                            "ENDPOINT",
                            "URL",
                            "ADDR",
                            "HOST",
                            "PROD",
                            "UAT",
                            "DEV",
                            "TEST",
                            "STAGING",
                        ].includes(word),
                )
                .join(" ")
                .toLowerCase();
            if (candidate.length < 4) return;
            const externalId = kebab(candidate);
            if (!nodes.some((n) => n.id === externalId)) {
                nodes.push({
                    id: externalId,
                    label: titleCase(candidate),
                    kind: "external",
                    archetype: "cloud",
                    parentId: ensureExternalsDistrict(),
                    description: `External receiver declared by the ${host.name} host's exporter configuration (${envToken}).`,
                    sourceRefs: [{ path: config }],
                    display: { flowLayer: 4 },
                });
            }
            addEdge({
                id: `${from}--${externalId}`,
                from,
                to: externalId,
                kind: "data_flow",
                evidence: "declared",
                label: "OTLP export",
                sourceRefs: [{ path: config }],
            });
        });
    }
}

// 7b. Cloudflare edge district.
if (edgeHost) {
    const districtId = "edge-delivery";
    nodes.push({
        id: districtId,
        label: "Cloudflare edge",
        kind: "scope",
        archetype: "district",
        description: `Edge deployment declared in ${edgeHost.file}.`,
    });
    nodes.push({
        id: "edge-worker",
        label: titleCase(edgeHost.name),
        kind: "deployable",
        archetype: "worker",
        parentId: districtId,
        description: `Cloudflare Worker${edgeHost.main ? ` with entry point ${edgeHost.main}` : ""}.`,
        sourceRefs: [{ path: edgeHost.main ?? edgeHost.file }],
        display: { flowLayer: 0 },
    });
    if (edgeHost.main) claimedSegments.add(edgeHost.main.split("/")[0]);
    for (const binding of edgeHost.d1) {
        const id = kebab(`d1-${binding.database_name ?? binding.binding}`);
        nodes.push({
            id,
            label: binding.database_name ?? binding.binding,
            kind: "infra",
            archetype: "database",
            parentId: districtId,
            sourceRefs: [{ path: edgeHost.file }],
            display: { flowLayer: 1 },
        });
        addEdge({ id: `edge-worker--${id}`, from: "edge-worker", to: id, kind: "depends_on", evidence: "declared" });
    }
}

// 7c. Package districts for code not claimed by a deployed service.
// A real runnable package (CLI, web app) keeps its building. A generic
// package (role "package") would produce one synthetic building holding
// everything, so it is flattened: its rooms are promoted to campus-level
// structures, each expandable into a building when its directory has
// internal structure.
function childRoomsOf(room) {
    const prefix =
        room.segment === "(root)" ? null : room.pkg.dir === "." ? room.segment : join(room.pkg.dir, room.segment);
    if (!prefix) return [];
    const groups = new Map();
    for (const file of room.files) {
        const rest = relative(prefix, file);
        let seg;
        if (rest.includes(sep)) {
            seg = rest.split(sep)[0];
        } else if ((fileCoupling.get(file)?.in ?? 0) === 0) {
            // A loose file nothing imports is its own module (a CLI, an installer),
            // not filing material: give it its own room named after the file.
            seg = rest.replace(/\.[a-z]+$/, "");
        } else {
            seg = "(files)"; // loose files imported by the entries: support code
        }
        groups.set(seg, [...(groups.get(seg) ?? []), file]);
    }
    return [...groups.entries()].map(([seg, files]) => ({ seg, files }));
}

// Source refs for a child of a room: the subdirectory when dir-backed, the
// concrete files (capped) when it is a loose-file group.
function childSourceRefs(room, child) {
    const dir = roomDir(room);
    if (child.files.length === 1) return [{ path: child.files[0] }];
    if (child.seg !== "(files)" && child.files.every((f) => f.startsWith(join(dir, child.seg) + sep))) {
        return [{ path: join(dir, child.seg) }];
    }
    return child.files.slice(0, 5).map((path) => ({ path }));
}

// Interior structure: two subdirs, or one subdir plus loose files.
function hasInteriorStructure(room) {
    const allChildren = childRoomsOf(room);
    const dirChildren = allChildren.filter(({ seg }) => seg !== "(files)");
    return dirChildren.length >= 2 || (dirChildren.length >= 1 && allChildren.length >= 2);
}

const promotedNodes = []; // district-less / own-district residual nodes
for (const pkg of packages) {
    const pkgRooms = [...rooms.values()].filter((room) => {
        if (room.pkg !== pkg || room.files.length === 0) return false;
        if (claimedSegments.has(pkg.dir === "." ? room.segment : join(pkg.dir, room.segment))) return false;
        if (isUtilityRoom(room.id)) return false;
        // lib rooms are shared plumbing, not deployment shape: excluded by
        // decision, like the C2-eliminated utility rooms.
        if (basename(room.segment) === "lib") return false;
        // Orphans: imported by nothing, reachable from nothing, no OTLP coupling,
        // not an entry dir, not referenced by path from another package. Sample
        // and demo material (examples/) falls out here.
        if (
            !pathReassignments.has(room.id) &&
            (roomCoupling.get(room.id)?.in ?? 0) === 0 &&
            !ENTRY_DIR_NAMES.has(basename(room.segment)) &&
            room.files.every((f) => !deployReachable.has(f) && !scriptReachable.has(f)) &&
            !room.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f))))
        ) {
            warnings.push(
                `Orphan area excluded (unreferenced, undeployed): ${room.segment} (${room.files.length} files).`,
            );
            return false;
        }
        return true;
    });
    if (!pkgRooms.length) continue;
    const scopeId = `${pkg.id}-area`;
    // Residual: compose services already claimed part of this package, so the
    // remaining code is operator tooling rather than the deployable itself.
    const residual = [...serviceClaimedDirs].some((dir) => owningPackage(dir) === pkg);

    const entries = pkgRooms
        .filter((r) => ENTRY_DIR_NAMES.has(basename(r.segment)) || r.segment === "(root)")
        .map((r) => r.id);
    const layers = layerByLongestPath(
        pkgRooms.map((r) => r.id),
        roomEdges,
        entries,
    );

    // A district never wraps a single synthetic building: rooms are promoted to
    // campus structures directly. Non-residual packages keep a package district
    // as the grouping; residual leftovers get a district per structured dir
    // (devstack, bootstrap) and district-less nodes for flat dirs.
    if (!residual && !nodes.some((n) => n.id === scopeId)) {
        nodes.push({
            id: scopeId,
            label: titleCase(pkg.name),
            kind: "scope",
            archetype: "district",
            description: `Package ${pkg.name}, rooted at ${pkg.dir === "." ? "the repository root" : `${pkg.dir}/`}.`,
        });
    }
    for (const room of pkgRooms) {
        const expandable = hasInteriorStructure(room);
        const children = expandable ? childRoomsOf(room) : [];
        const label = room.segment === "(root)" ? "Top-level files" : titleCase(room.segment.split(sep).join(" / "));
        let parentId;
        const reassigned = pathReassignments.get(room.id);
        if (reassigned) {
            parentId = `${reassigned.pkg.id}-area`;
            if (!nodes.some((n) => n.id === parentId)) {
                nodes.push({
                    id: parentId,
                    label: titleCase(reassigned.pkg.name),
                    kind: "scope",
                    archetype: "district",
                    description: `Package ${reassigned.pkg.name}, rooted at ${reassigned.pkg.dir === "." ? "the repository root" : `${reassigned.pkg.dir}/`}.`,
                });
            }
            const fromRoom = fileToRoom.get(reassigned.fromFile);
            if (fromRoom) {
                addEdge({
                    id: `${fromRoom.id}--${room.id}`,
                    from: fromRoom.id,
                    to: room.id,
                    kind: "depends_on",
                    evidence: "declared",
                    label: "path reference",
                    sourceRefs: [{ path: reassigned.fromFile }],
                });
            }
        } else if (!residual) {
            parentId = scopeId;
        } else if (expandable) {
            // A residual structured dir never wraps a single building either: the
            // district holds the dir's parts directly as campus structures.
            const districtId = `${room.id}-district`;
            nodes.push({
                id: districtId,
                label,
                kind: "scope",
                archetype: "district",
                description: `Standalone area: ${room.segment}/.`,
            });
            for (const child of children) {
                // Loose imported files ("Support files") and lib children are shared
                // plumbing, not deployment shape: excluded by decision.
                if (child.seg === "(files)" || child.seg === "lib") continue;
                const childId = uniqueNodeId(kebab(`${room.id}-${child.seg}`));
                const childLoc = child.files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
                const childAsBuilding = modulesAsBuildings && child.files.length >= 2;
                // Same entry classification as the overview (O2): a script-referenced
                // file or an entry-named loose file (redeploy-cli) is an entry point.
                const childIsEntry =
                    child.files.some((f) => scriptReferencedFiles.has(f)) ||
                    (child.files.length === 1 && ENTRY_FILE_PATTERN.test(child.seg));
                nodes.push({
                    id: childId,
                    label: titleCase(child.seg),
                    kind: "module",
                    archetype: childAsBuilding ? "building" : childIsEntry ? "gateway" : "worker",
                    ...(childIsEntry && child.files.length === 1
                        ? { attributes: { "entry-point": child.files[0] } }
                        : {}),
                    parentId: districtId,
                    description: `${child.files.length} source file${child.files.length === 1 ? "" : "s"} under ${room.segment}/.`,
                    sourceRefs: childSourceRefs(room, child),
                    metrics: { loc: childLoc },
                });
                if (childAsBuilding) pushFileRooms(childId, child.files);
                for (const f of child.files) fileNodeOwner.set(f, childId);
                promotedNodes.push({ id: childId, files: child.files });
            }
            continue;
        }
        const isEntry = ENTRY_DIR_NAMES.has(basename(room.segment));
        const leafAsBuilding = modulesAsBuildings && !expandable && room.files.length >= 2;
        nodes.push({
            id: room.id,
            label,
            kind: "module",
            archetype: expandable || leafAsBuilding ? "building" : isEntry ? "gateway" : "worker",
            ...(parentId ? { parentId } : {}),
            description: `${room.files.length} source file${room.files.length === 1 ? "" : "s"} under ${room.segment === "(root)" ? "the package root" : `${room.segment}/`}.`,
            sourceRefs:
                room.segment === "(root)"
                    ? room.files.slice(0, 5).map((path) => ({ path }))
                    : [{ path: roomDir(room) }],
            metrics: { loc: room.loc },
            display: { flowLayer: layers.get(room.id) ?? 0 },
        });
        for (const f of room.files) fileNodeOwner.set(f, room.id);
        promotedNodes.push({ id: room.id, files: room.files });
        if (leafAsBuilding) pushFileRooms(room.id, room.files);
        if (expandable) {
            for (const child of children) {
                if (child.seg === "lib") continue; // shared plumbing, not shape
                nodes.push({
                    id: uniqueNodeId(kebab(`${room.id}-${child.seg}`)),
                    label: child.seg === "(files)" ? "Top-level files" : titleCase(child.seg),
                    kind: "module",
                    archetype: "room",
                    parentId: room.id,
                    description: `${child.files.length} source file${child.files.length === 1 ? "" : "s"}.`,
                    sourceRefs: childSourceRefs(room, child),
                });
            }
        }
    }
}

// 7c-i. The web entry deploys to the edge worker: wrangler builds and serves
// the owning package's app, so the app entry carries a deploys edge.
if (edgeHost && nodes.some((n) => n.id === "edge-worker")) {
    const ownerPkg = owningPackage(edgeHost.file);
    const entryRoom = [...rooms.values()].find(
        (r) => r.pkg === ownerPkg && ENTRY_DIR_NAMES.has(basename(r.segment)) && nodes.some((n) => n.id === r.id),
    );
    if (entryRoom) {
        addEdge({
            id: `${entryRoom.id}--edge-worker`,
            from: entryRoom.id,
            to: "edge-worker",
            kind: "deploys",
            evidence: "declared",
            label: "wrangler deploy",
            sourceRefs: [{ path: edgeHost.file }],
        });
    }
}

// 7c-ii. OTLP producers: residual nodes whose source configures OpenTelemetry
// export get a data_flow edge into the OTLP-receiving collector, pulling data
// generators and agent plugins toward the ingress host they feed.
const collectorTarget =
    nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id) && /gateway/.test(n.id)) ??
    nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id));
if (collectorTarget) {
    for (const promoted of promotedNodes) {
        const emitsOtlp = promoted.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f))));
        if (!emitsOtlp) continue;
        addEdge({
            id: `${promoted.id}--${collectorTarget.id}`,
            from: promoted.id,
            to: collectorTarget.id,
            kind: "data_flow",
            evidence: "inferred",
            confidence: 0.7,
            label: "OTLP export",
        });
    }
}

// 7c-iii (removed): eliminated shared-utility rooms used to reappear as a
// per-district "Shared libraries" copy. Dropped by decision — the copies
// repeated across every district without adding information; C2 elimination
// now simply removes shared code from the deployment map.

// 7d. Room-level and package-level import edges (only between nodes that exist).
const nodeIds = new Set(nodes.map((n) => n.id));
for (const [key, count] of roomEdges) {
    const [from, to] = key.split("->");
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    addEdge({
        id: `${from}--${to}`,
        from,
        to,
        kind: "depends_on",
        evidence: "declared",
        label: `${count} import${count === 1 ? "" : "s"}`,
    });
}
for (const key of packageEdges.keys()) {
    const [from, to] = key.split("->");
    if (nodeIds.has(from) && nodeIds.has(to)) {
        addEdge({ id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared" });
    }
}

// 7d-ii. Owner-level import edges: aggregate file imports by emitted campus
// node. Covers flattened district children, which the room-level pass above
// cannot see; addEdge's id dedup keeps existing pairs untouched.
const ownerEdgeCounts = new Map();
for (const { from, to } of fileEdges) {
    const a = fileNodeOwner.get(from);
    const b = fileNodeOwner.get(to);
    if (!a || !b || a === b || !nodeIds.has(a) || !nodeIds.has(b)) continue;
    const key = `${a}->${b}`;
    ownerEdgeCounts.set(key, (ownerEdgeCounts.get(key) ?? 0) + 1);
}
for (const [key, count] of ownerEdgeCounts) {
    const [from, to] = key.split("->");
    addEdge({
        id: `${from}--${to}`,
        from,
        to,
        kind: "depends_on",
        evidence: "declared",
        label: `${count} import${count === 1 ? "" : "s"}`,
    });
}

// 7e. Drizzle database when no D1 binding declared it already.
if (drizzleConfig && ![...nodeIds].some((id) => id.startsWith("d1-"))) {
    const dialect = /dialect:\s*["'](\w+)["']/.exec(readText(join(repo, drizzleConfig)))?.[1];
    const owner = owningPackage(drizzleConfig);
    const parent = edgeHost ? "edge-delivery" : owner ? `${owner.id}-area` : undefined;
    if (parent && nodeIds.has(parent)) {
        nodes.push({
            id: "drizzle-database",
            label: `Database (${dialect ?? "sql"})`,
            kind: "infra",
            archetype: "database",
            parentId: parent,
            description: `Drizzle ORM schema declared in ${drizzleConfig}.`,
            sourceRefs: [{ path: drizzleConfig }],
            display: { flowLayer: 1 },
        });
        const from = edgeHost ? "edge-worker" : owner?.id;
        if ((from && nodeIds.has(from)) || nodes.some((n) => n.id === from)) {
            addEdge({
                id: `${from}--drizzle-database`,
                from,
                to: "drizzle-database",
                kind: "depends_on",
                evidence: "declared",
            });
        }
    }
}

// 7e-i. Embedded databases (same dependency scan as overview mode's O11):
// the node lives in the district of the first module importing the SDK, and
// importers get inferred reads/writes data flow.
for (const database of embeddedDatabases) {
    const escaped = database.depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importPattern = new RegExp(`(from\\s+|require\\()["']${escaped}`);
    const importerOwners = [];
    for (const file of sourceFiles) {
        if (!importPattern.test(readText(join(repo, file)))) continue;
        const owner = fileNodeOwner.get(file);
        if (owner && nodes.some((n) => n.id === owner) && !importerOwners.includes(owner)) importerOwners.push(owner);
    }
    const parentDistrict = importerOwners
        .map((owner) => nodes.find((n) => n.id === owner)?.parentId)
        .find((parent) => parent && nodes.some((n) => n.id === parent && n.kind === "scope"));
    nodes.push({
        id: database.id,
        label: database.label,
        kind: "infra",
        archetype: "database",
        ...(parentDistrict ? { parentId: parentDistrict } : {}),
        description: database.description,
        sourceRefs: [{ path: database.path }],
        display: { flowLayer: 2 },
    });
    for (const owner of importerOwners) {
        addEdge({
            id: `${owner}--${database.id}`,
            from: owner,
            to: database.id,
            kind: "data_flow",
            evidence: "inferred",
            confidence: 0.7,
            label: "reads/writes",
            sourceRefs: [{ path: database.path }],
        });
    }
}

// 7e-ii. CI workflow jobs (D9-D12). A GitHub Actions workflow with a schedule,
// a workflow_run chain, or a run step invoking repo code becomes a CI job
// district. Object-storage traffic becomes an external store with directional
// data flow; an invoked entry's Commander subcommand resolves to its handler
// module for a `runs` edge.
const nodeOwningFile = (file) => {
    const direct = fileNodeOwner.get(file);
    if (direct && nodes.some((n) => n.id === direct)) return direct;
    let best = null;
    for (const node of nodes) {
        if (node.kind === "scope") continue;
        for (const ref of node.sourceRefs ?? []) {
            if (!ref.path) continue;
            if (file === ref.path || file.startsWith(`${ref.path.replace(/\/$/, "")}/`)) {
                if (!best || ref.path.length > best.length) best = { id: node.id, length: ref.path.length };
            }
        }
    }
    return best?.id ?? null;
};
// Commander registration: the handler is the first imported identifier used
// inside the `.command('<sub>')` chunk of the entry file.
const subcommandHandlerFile = (entryFile, sub) => {
    const text = readText(join(repo, entryFile));
    const importedNames = new Map(); // identifier -> specifier
    for (const match of text.matchAll(/import\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/g)) {
        for (const raw of match[1].split(",")) {
            const identifier = raw
                .trim()
                .split(/\s+as\s+/)
                .pop();
            if (identifier) importedNames.set(identifier, match[2]);
        }
    }
    const chunkMatch = new RegExp(`\\.command\\(['"]${sub}(?:\\s[^'"]*)?['"]\\)([\\s\\S]*?)(?=\\.command\\(|$)`).exec(
        text,
    );
    if (!chunkMatch) return null;
    let first = null;
    for (const [identifier, specifier] of importedNames) {
        const at = chunkMatch[1].indexOf(identifier);
        if (at >= 0 && (!first || at < first.at)) first = { at, specifier };
    }
    return first ? (resolveImport(entryFile, first.specifier)?.file ?? null) : null;
};
const ciJobId = new Map(ciWorkflows.map((w) => [w.name, kebab(`ci-${w.name}-job`)]));
for (const workflow of ciWorkflows) {
    const districtId = kebab(`ci-${workflow.name}`);
    const jobId = ciJobId.get(workflow.name);
    nodes.push({
        id: districtId,
        label: `CI: ${workflow.name}`,
        kind: "scope",
        archetype: "district",
        description: `GitHub Actions workflow declared in ${workflow.file}.`,
    });
    nodes.push({
        id: jobId,
        label: titleCase(workflow.name),
        kind: "deployable",
        archetype: "worker",
        parentId: districtId,
        description: [
            `CI job from ${workflow.file}.`,
            workflow.cron ? `Scheduled (${workflow.cron}).` : null,
            workflow.triggeredBy.length ? `Runs after: ${workflow.triggeredBy.join(", ")}.` : null,
            ...workflow.invocations.map((inv) => `Runs ${inv.file}${inv.sub ? ` ${inv.sub}` : ""}.`),
        ]
            .filter(Boolean)
            .join(" "),
        sourceRefs: [{ path: workflow.file }],
        tags: workflow.cron ? ["cron"] : [],
        display: { flowLayer: 1 },
    });
    if (workflow.storage) {
        const storeId = kebab(`external-${workflow.storage.label}`);
        if (!nodes.some((n) => n.id === storeId)) {
            nodes.push({
                id: storeId,
                label: workflow.storage.label,
                kind: "external",
                archetype: "storage",
                parentId: ensureExternalsDistrict(),
                description: `Object store addressed from CI workflows.`,
                sourceRefs: [{ path: workflow.file }],
                display: { flowLayer: 2 },
            });
        }
        if (workflow.storage.downloads) {
            addEdge({
                id: `${storeId}--${jobId}`,
                from: storeId,
                to: jobId,
                kind: "data_flow",
                evidence: "declared",
                label: "downloads",
                sourceRefs: [{ path: workflow.file }],
            });
        }
        if (workflow.storage.uploads) {
            addEdge({
                id: `${jobId}--${storeId}`,
                from: jobId,
                to: storeId,
                kind: "data_flow",
                evidence: "declared",
                label: "uploads",
                sourceRefs: [{ path: workflow.file }],
            });
        }
    }
    for (const upstream of workflow.triggeredBy) {
        const upstreamId = ciJobId.get(upstream);
        if (upstreamId) {
            addEdge({
                id: `${upstreamId}--${jobId}`,
                from: upstreamId,
                to: jobId,
                kind: "calls",
                evidence: "declared",
                label: "triggers on completion",
                sourceRefs: [{ path: workflow.file }],
            });
        }
    }
    for (const invocation of workflow.invocations) {
        const entryOwner = nodeOwningFile(invocation.file);
        if (entryOwner) {
            addEdge({
                id: `${jobId}--${entryOwner}`,
                from: jobId,
                to: entryOwner,
                kind: "calls",
                evidence: "declared",
                label: `runs ${basename(invocation.file)}${invocation.sub ? ` ${invocation.sub}` : ""}`,
                sourceRefs: [{ path: workflow.file }],
            });
        }
        if (invocation.sub) {
            const handlerFile = subcommandHandlerFile(invocation.file, invocation.sub);
            const handlerOwner = handlerFile ? nodeOwningFile(handlerFile) : null;
            if (handlerOwner && handlerOwner !== entryOwner) {
                addEdge({
                    id: `${jobId}--${handlerOwner}-h`,
                    from: jobId,
                    to: handlerOwner,
                    kind: "calls",
                    evidence: "declared",
                    label: `${invocation.sub} handler`,
                    sourceRefs: [{ path: handlerFile }],
                });
            }
        }
    }
}

// 7e-iii. Config-declared external services (D12): an https URL assigned as a
// value in a package-root config.yaml names an external system the package's
// CLI entry fetches from.
for (const pkg of packages) {
    const configFile = ["config.yaml", "config.yml"]
        .map((candidate) => (pkg.dir === "." ? candidate : `${pkg.dir}/${candidate}`))
        .find(fileExists);
    if (!configFile) continue;
    const packageJson = readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {};
    const binTargets = typeof packageJson.bin === "string" ? [packageJson.bin] : Object.values(packageJson.bin ?? {});
    const entrySource = binTargets
        .map((target) =>
            join(pkg.dir === "." ? "" : pkg.dir, target)
                .replace(/(^|\/)dist\//, "$1src/")
                .replace(/\.js$/, ".ts"),
        )
        .find(fileExists);
    const fromId = entrySource ? nodeOwningFile(entrySource) : null;
    for (const line of readText(join(repo, configFile)).split("\n")) {
        if (/^\s*#/.test(line)) continue;
        const urlMatch = /:\s*['"]?(https:\/\/[^'"\s]+)/.exec(line);
        if (!urlMatch) continue;
        let hostname;
        try {
            hostname = new URL(urlMatch[1]).hostname;
        } catch {
            continue;
        }
        if (/localhost|^127\.|cloudflarestorage\.com$/.test(hostname)) continue;
        const externalId = kebab(`external-${hostname}`);
        if (!nodes.some((n) => n.id === externalId)) {
            nodes.push({
                id: externalId,
                label: hostname,
                kind: "external",
                archetype: "cloud",
                parentId: ensureExternalsDistrict(),
                description: `External service configured in ${configFile}.`,
                sourceRefs: [{ path: configFile }],
                display: { flowLayer: 0 },
            });
        }
        if (fromId) {
            addEdge({
                id: `${externalId}--${fromId}`,
                from: externalId,
                to: fromId,
                kind: "data_flow",
                evidence: "declared",
                label: "fetches",
                sourceRefs: [{ path: configFile }],
            });
        }
    }
}

// 7f. Static I/O classification (data flow from code, no runtime evidence).
// Declared boundary roles become tags: a module that starts a server listens;
// one that constructs HTTP clients calls out. Database sinks/sources become
// directional data_flow edges: SQL/ORM writes flow node -> database, reads
// flow database -> node. Inferred evidence, because the *binding* to a
// specific database node is not stated in the code.
const LISTEN_PATTERN = /Bun\.serve|\.listen\s*\(|createServer\s*\(|@fastify|express\s*\(\)/;
const HTTP_CLIENT_PATTERN = /\bfetch\s*\(|axios[.(]|new\s+Request\s*\(/;

const classificationSets = [...campusFileSets, ...promotedNodes.map(({ id, files }) => ({ id, files }))];
const districtLookup = new Map(
    nodes
        .filter((n) => n.parentId && nodes.some((s) => s.id === n.parentId && s.kind === "scope"))
        .map((n) => [n.id, n.parentId]),
);
const databaseNodes = nodes.filter((n) => n.archetype === "database");

// 7f-i. Nodes referencing an external by SDK import or env-var prefix deliver
// data to it (the delivery command pushing scores into Langfuse/Latitude).
// Mirrors overview mode's delivers inference.
for (const external of nodes.filter((n) => n.kind === "external")) {
    const name = external.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (name.length < 4) continue;
    const referencePattern = new RegExp(`from\\s+["'][^"']*${name}|\\b${name.toUpperCase()}_[A-Z]`);
    for (const { id, files } of classificationSets) {
        if (id === external.id || !files.length) continue;
        if (files.some((f) => referencePattern.test(readText(join(repo, f))))) {
            addEdge({
                id: `${id}--${external.id}-d`,
                from: id,
                to: external.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.6,
                label: "delivers",
            });
        }
    }
}

for (const { id, files, entryFile } of classificationSets) {
    const node = nodes.find((n) => n.id === id);
    if (!node || !files.length) continue;
    // Deployment structures size like overview modules (O5): height from lines
    // of code, floor area from the worst single function inside. Height is
    // log-scaled — these are multi-file aggregates (services run to 5 figures
    // of loc) and the overview's linear cap would flatten them all.
    const sizedLoc = files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
    const sizedComplexity = Math.max(...files.map((f) => fileMaxFunctionComplexity(f)));
    const sizedHeight = Math.max(0.6, 0.6 + Math.log2(1 + sizedLoc / 200) * 0.55);
    const sizedFootprint = Math.min(2.5, Math.max(0.95, 0.85 + Math.sqrt(sizedComplexity) / 4));
    const coverage = coverageForFiles(files);
    node.metrics = {
        ...(node.metrics ?? {}),
        loc: sizedLoc,
        complexity: sizedComplexity,
        ...(coverage !== null ? { coverage } : {}),
    };
    node.display = { ...(node.display ?? {}), size: [sizedFootprint, sizedHeight, sizedFootprint * 0.85] };
    // TSDoc prose leads the description as its own paragraph: the node's
    // DECLARED entry file wins (a service's Dockerfile entrypoint), else the
    // best entry-like file by name.
    const doc = (entryFile ? fileDocSummary(entryFile) : null) ?? docForFiles(files);
    if (doc && !node.description?.startsWith(doc)) {
        node.description = [doc, node.description].filter(Boolean).join("\n\n");
    }
    let listens = false,
        callsOut = false,
        writes = false,
        reads = false;
    for (const file of files) {
        const text = readText(join(repo, file));
        listens ||= LISTEN_PATTERN.test(text);
        callsOut ||= HTTP_CLIENT_PATTERN.test(text);
        writes ||= DB_WRITE_PATTERN.test(text);
        reads ||= DB_READ_PATTERN.test(text);
    }
    const tags = new Set(node.tags ?? []);
    if (listens) tags.add("listens");
    if (callsOut) tags.add("http-client");
    if (tags.size) node.tags = [...tags];
    if (!writes && !reads) continue;
    const database =
        databaseNodes.find((db) => districtLookup.get(db.id) === districtLookup.get(id)) ?? databaseNodes[0];
    if (!database || database.id === id) continue;
    if (writes) {
        addEdge({
            id: `${id}--${database.id}-w`,
            from: id,
            to: database.id,
            kind: "data_flow",
            evidence: "inferred",
            confidence: 0.75,
            label: "writes",
        });
    }
    if (reads) {
        addEdge({
            id: `${database.id}--${id}-r`,
            from: database.id,
            to: id,
            kind: "data_flow",
            evidence: "inferred",
            confidence: 0.75,
            label: "reads",
        });
    }
}

// --- 8. Emit map and intermediate artefacts ----------------------------------------

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
        services: h.services.map(({ name, image, dockerfile, entryFile, copies, schedule, hasPorts, imageClass }) => ({
            name,
            image,
            dockerfile,
            entryFile,
            copies,
            schedule,
            hasPorts,
            imageClass,
        })),
    })),
    crontabs: crontabFiles,
    wrangler: edgeHost,
    drizzle: drizzleConfig ?? null,
};

const roomEdgeList = [...roomEdges.entries()].map(([key, count]) => {
    const [from, to] = key.split("->");
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
function mermaidId(id) {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
}
function mermaidLabel(text) {
    return text.replace(/"/g, "'");
}
const isCampus = (n) =>
    n.kind !== "scope" && (!n.parentId || nodes.some((s) => s.id === n.parentId && s.kind === "scope"));
const nodePath = (n) => {
    const paths = (n.sourceRefs ?? []).map((ref) => ref.path).filter(Boolean);
    return paths.length ? paths.slice(0, 2).join(", ") + (paths.length > 2 ? ", …" : "") : undefined;
};
const campusNodeLine = (n, indent, extra = "") => {
    const path = nodePath(n);
    return `${indent}${mermaidId(n.id)}["${mermaidLabel(n.label)}<br/><i>${n.archetype}${extra}</i>${path ? `<br/>${mermaidLabel(path)}` : ""}"]`;
};
// A building with rooms renders as a nested subgraph so interiors are visible.
const campusNodeLines = (n, indent, extra = "") => {
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
let sharedBreakdown = null;
if (eliminatedRooms.length) {
    const memberFiles = new Set(eliminatedRooms.flatMap((r) => rooms.get(r.id).files));
    const fileLine = (room, file) => {
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
            const room = rooms.get(r.id);
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
