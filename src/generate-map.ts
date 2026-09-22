#!/usr/bin/env bun

// Deterministic (agent-free) Functionary city map generator, orchestrating
// the typed modules under src/lib/ (one per HEURISTICS.md rule group; see
// docs/rfcs/rfc-0001-generator-extraction.md).
//
// Usage: bun src/generate-map.ts <target-repo> [--out-dir out/<name>] [--overview]
// Outputs: map.json, deploy-shape.json, deps-files.json, deps-rooms.json, deps-rooms.dot

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArguments, USAGE } from "./lib/arguments.ts";
import { assembleDeployment } from "./lib/assemble-deployment.ts";
import { runOverview } from "./lib/assemble-overview.ts";
import { createComplexityScanner, loadComplexityCompiler } from "./lib/complexity.ts";
import { analyseCoupling } from "./lib/coupling.ts";
import { parseCrontabSchedules } from "./lib/crontab.ts";
import { findSpawnedEntries } from "./lib/daemons.ts";
import { emitArtefacts } from "./lib/emit.ts";
import { layerHosts, scanHostConfigs } from "./lib/host-config.ts";
import { buildHosts } from "./lib/hosts.ts";
import { scanImports } from "./lib/imports.ts";
import { extensionOf, inventory, isTestPath, SOURCE_EXTENSIONS } from "./lib/inventory.ts";
import { discoverPackages, discoverPythonPackages, packageDirsOf, pythonPackageDirsOf } from "./lib/packages.ts";
import { findPathReassignments } from "./lib/path-references.ts";
import { analyseReachability, stripDevTooling } from "./lib/reachability.ts";
import { readText } from "./lib/read.ts";
import { buildRooms } from "./lib/rooms.ts";
import { findRunnableApps } from "./lib/runnable.ts";
import { createDocScanner, findEmbeddedDatabases, findExternalServiceDeps, scanCoverage } from "./lib/scans.ts";
import { scanCiWorkflows } from "./lib/workflows.ts";
import { findEdgeHost } from "./lib/wrangler.ts";

const ENTRY_DIR_NAMES = new Set(["bin", "app", "pages", "routes", "cmd", "cli", "api"]);

// Tool configuration written in a code extension is config, not code:
// vite.config.ts, marp.config.mjs, vitest-setup.ts, .eslintrc.js, ...
const CONFIG_FILE_PATTERN =
    /(?:^|\/)(?:[\w.-]*\.config\.(?:ts|js|mjs|cjs)|[\w.-]*-setup\.(?:ts|js|mjs)|\.\w+rc\.(?:js|cjs))$/;

// Method-call forms require a database-ish receiver: bare .delete()/.update()
// would match every JavaScript Map and Set.
const DB_WRITE_PATTERN =
    /insert\s+into\s|delete\s+from\s|\bupdate\s+\w+\s+set\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.(?:insert|update|delete|upsert)\s*\(/i;
const DB_READ_PATTERN =
    /\bselect\s[\s\S]{0,80}?\bfrom\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.select\s*\(/i;
// HC-024: a module must reference a database client (an SDK import, a pool,
// a client factory) for its SQL-form matches to draw data-flow edges — the
// pattern alone fires on string literals in browser components (paperclip's
// UI, supabase's studio components).
const DB_CLIENT_PATTERN =
    /(from\s+["'](pg|postgres|mysql|mysql2|sqlite3|better-sqlite3|kysely|typeorm|drizzle|duckdb|@duckdb\/|embedded-postgres|@vercel\/postgres|@libsql\/|@prisma\/client|sequelize|mongoose|mongodb|redis|@redis\/))|(createPool\s*\(|new\s+Pool\s*\(|createConnection\s*\(|drizzle\s*\(|prisma\.\w+\.\w+\s*\()/i;

/**
 * Runs the generator pipeline for the given CLI arguments and returns the
 * process exit code: 2 on usage error (USAGE printed to stderr), 0 otherwise.
 *
 * @param argumentsList - Raw CLI arguments (argv without the runtime and
 *   script entries): the target repo plus optional --out-dir, --overview,
 *   and --modules-as-buildings flags.
 * @returns The process exit code: 2 when no target repo was given, 0 after a
 *   successful map generation.
 */
export async function runGenerator(argumentsList: readonly string[]): Promise<number> {
    const parsedArguments = parseArguments(argumentsList);
    if (!parsedArguments) {
        console.error(USAGE);
        return 2;
    }
    const { repo, outDir, modulesAsBuildings, overview } = parsedArguments;

    mkdirSync(outDir, { recursive: true });

    // 1. Inventory
    const allFiles = inventory(repo);
    const sourceFiles = allFiles.filter(
        (f) =>
            SOURCE_EXTENSIONS.has(extensionOf(f)) &&
            !isTestPath(f) &&
            !CONFIG_FILE_PATTERN.test(f) &&
            !/\.d\.ts$/.test(f),
    );

    // 2. Packages
    const packageDirs = packageDirsOf(allFiles);
    const usedIds = new Set<string>();
    const packages = discoverPackages(repo, packageDirs, usedIds);
    // HC-026: directories with a pyproject.toml/uv.lock/requirements.txt are
    // Python packages (immich's machine-learning/). A directory that already
    // has a package.json keeps its Node identity.
    const pythonDirs = pythonPackageDirsOf(allFiles).filter((dir) => !packageDirs.includes(dir));
    packages.push(...discoverPythonPackages(repo, pythonDirs, usedIds));

    // 3. Rooms
    const rooms = buildRooms(repo, packages, sourceFiles);

    // 4. Import scan and coupling
    const { fileToRoom, resolveImport, fileEdges, packageEdges, roomEdges } = scanImports(
        repo,
        packages,
        rooms,
        sourceFiles,
    );
    const { fileComplexity, fileMaxFunctionComplexity } = createComplexityScanner(repo, await loadComplexityCompiler());
    const { fileCoupling, roomCoupling, isUtilityRoom, eliminatedRooms } = analyseCoupling(fileEdges, roomEdges, rooms);

    // 5. Deployment shape
    const composeFiles = allFiles.filter((f) => /docker-compose[^/]*\.(yml|yaml)$/.test(basename(f)));
    const crontabFiles = allFiles.filter((f) => /^crontab/.test(basename(f)));
    const schedules = parseCrontabSchedules(crontabFiles.map((f) => [f, readText(join(repo, f))]));
    const { hosts, candidateHosts, serviceDependsOn, serviceOwner } = buildHosts(
        repo,
        allFiles,
        composeFiles,
        schedules,
    );
    const edgeHost = findEdgeHost(repo, allFiles);
    const drizzleConfig = allFiles.find((f) => /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f));
    const embeddedDatabases = findEmbeddedDatabases(packages);
    const externalServiceDeps = findExternalServiceDeps(packages);
    const ciWorkflows = scanCiWorkflows(repo, allFiles);
    const hostScan = scanHostConfigs(repo, allFiles, hosts);
    const hostLayer = layerHosts(hostScan, hosts);
    const { coverageForFiles } = scanCoverage(repo, packageDirs);
    const { fileDocSummary, docForFiles } = createDocScanner(repo);

    // D16: apps run directly (a server started from a start/serve script, or a
    // web SPA rooted at its package) — recognised before reachability so their
    // entries seed deploy roots.
    const runnableApps = findRunnableApps(repo, packages, sourceFiles);

    // 6. Dev-tooling detection by reachability
    const reachability = analyseReachability(
        repo,
        packages,
        hosts,
        edgeHost,
        sourceFiles,
        fileEdges,
        fileToRoom,
        runnableApps,
    );
    const { deployReachable, hostDeployReachable, hasHostDeployShape, scriptReachable, scriptReferencedFiles } =
        reachability;
    const devToolingWarnings = stripDevTooling(repo, rooms, reachability, fileEdges);
    // D15: daemons spawned from deploy-reachable (non-test) source.
    const spawnedEntries = findSpawnedEntries(
        repo,
        sourceFiles.filter((f) => deployReachable.has(f)),
        new Set(sourceFiles),
    );

    if (overview) {
        await runOverview({
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
            dbWritePattern: DB_WRITE_PATTERN,
            dbReadPattern: DB_READ_PATTERN,
            dbClientPattern: DB_CLIENT_PATTERN,
            scriptReachable,
            entryDirNames: ENTRY_DIR_NAMES,
        });
        return 0;
    }

    // 7 & 8. Assemble the deployment map, then emit it with the intermediates.
    const pathReassignments = findPathReassignments(repo, packages, rooms, sourceFiles);
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
        hostScan,
        serviceDependsOn,
        serviceOwner,
        hostLayer,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        externalServiceDeps,
        ciWorkflows,
        coverageForFiles,
        fileDocSummary,
        docForFiles,
        fileMaxFunctionComplexity,
        deployReachable,
        hostDeployReachable,
        hasHostDeployShape,
        scriptReachable,
        spawnedEntries,
        runnableApps,
        devToolingWarnings,
        pathReassignments,
        entryDirNames: ENTRY_DIR_NAMES,
        dbWritePattern: DB_WRITE_PATTERN,
        dbReadPattern: DB_READ_PATTERN,
        dbClientPattern: DB_CLIENT_PATTERN,
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
    return 0;
}

// Exercised by the golden-master tests in test/generate-map.test.ts, which run
// this entry point as a real subprocess via execFileSync("bun", ...); the
// coverage tool cannot detect that because the tests run it in a separate
// process.
/* v8 ignore start */
if (import.meta.main) {
    process.exitCode = await runGenerator(process.argv.slice(2));
}
/* v8 ignore stop */
