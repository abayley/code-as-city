#!/usr/bin/env node

// Deterministic (agent-free) Functionary city map generator. Being extracted
// into typed modules under src/lib/ per HEURISTICS.md rule group; see
// docs/rfc-0001-generator-extraction.md.
//
// Usage: bun src/generate-map.mjs <target-repo> [--out-dir out/<name>]
// Outputs: map.json, deploy-shape.json, deps-files.json, deps-rooms.json, deps-rooms.dot

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArguments, USAGE } from "./lib/arguments.ts";
import { assembleDeployment } from "./lib/assemble-deployment.ts";
import { runOverview } from "./lib/assemble-overview.ts";
import { createComplexityScanner } from "./lib/complexity.ts";
import { analyseCoupling } from "./lib/coupling.ts";
import { parseCrontabSchedules } from "./lib/crontab.ts";
import { emitArtefacts } from "./lib/emit.ts";
import { layerHosts, scanHostConfigs } from "./lib/host-config.ts";
import { buildHosts } from "./lib/hosts.ts";
import { scanImports } from "./lib/imports.ts";
import { extensionOf, inventory, isTestPath, SOURCE_EXTENSIONS } from "./lib/inventory.ts";
import { discoverPackages, packageDirsOf } from "./lib/packages.ts";
import { findPathReassignments } from "./lib/path-references.ts";
import { analyseReachability, stripDevTooling } from "./lib/reachability.ts";
import { readText } from "./lib/read.ts";
import { buildRooms } from "./lib/rooms.ts";
import { createDocScanner, findEmbeddedDatabases, scanCoverage } from "./lib/scans.ts";
import { scanCiWorkflows } from "./lib/workflows.ts";
import { findEdgeHost } from "./lib/wrangler.ts";

const ENTRY_DIR_NAMES = new Set(["bin", "app", "pages", "routes", "cmd", "cli", "api"]);

const parsedArguments = parseArguments(process.argv.slice(2));
if (!parsedArguments) {
    console.error(USAGE);
    process.exit(2);
}
const { repo, outDir, modulesAsBuildings, overview } = parsedArguments;

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

// --- 7 & 8. Assemble the map, then emit it with the intermediate artefacts.

const assembled = assembleDeployment({
    repo,
    modulesAsBuildings,
    allFiles,
    sourceFiles,
    packages,
    rooms,
    fileToRoom,
    resolveImport,
    fileEdges,
    packageEdges,
    roomEdges,
    fileCoupling,
    roomCoupling,
    isUtilityRoom,
    eliminatedRooms,
    hosts,
    candidateHosts,
    serviceDependsOn,
    hostLayer,
    edgeHost,
    drizzleConfig,
    embeddedDatabases,
    ciWorkflows,
    coverageForFiles,
    fileDocSummary,
    docForFiles,
    fileMaxFunctionComplexity,
    deployReachable,
    scriptReachable,
    scriptReferencedFiles,
    devToolingWarnings,
    pathReassignments,
    entryDirNames: ENTRY_DIR_NAMES,
    dbWritePattern: DB_WRITE_PATTERN,
    dbReadPattern: DB_READ_PATTERN,
});

await emitArtefacts({
    repo,
    outDir,
    nodes: assembled.nodes,
    edges: assembled.edges,
    warnings: assembled.warnings,
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
});
