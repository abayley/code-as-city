#!/usr/bin/env node

// PROTOTYPE - throwaway code answering one question:
// "How useful is a fully deterministic (agent-free) Functionary city map?"
// No tests, minimal error handling, mechanical naming by design.
//
// v2: test exclusion, deployment-shape detection (docker-compose hosts,
// Dockerfile service->source binding, crontab schedules, wrangler edge),
// and intermediate artefacts for heuristic exploration.
//
// Usage: node src/generate-map.mjs <target-repo> [--out-dir out/<name>]
// Outputs: map.json, deploy-shape.json, deps-files.json, deps-rooms.json, deps-rooms.dot

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { kebab, titleCase } from "./lib/text.ts";

const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "coverage",
    ".wrangler",
    ".turbo",
    "out",
    "vendor",
    ".venv",
    "__pycache__",
    ".functionary",
    ".repo-city",
    "generated",
    "docs",
    "examples",
    "data",
]);
// Codebase/dev utilities are detected by reachability, not by name: code
// reachable only from package.json scripts and imported by nothing that
// deploys is excluded from the map (see section 6b).
const TEST_DIRS = new Set(["test", "tests", "__tests__", "test-database", "testing"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ENTRY_DIR_NAMES = new Set(["bin", "app", "pages", "routes", "cmd", "cli", "api"]);
// Entry-like file basenames: exactly cli/cmd/main, or the *-cli / *-command
// suffix convention (redeploy-cli.ts, delivery-command.ts). Shared by both
// map modes.
const ENTRY_FILE_PATTERN = /(^|[-_.])(cli|cmd|command|main)$/;

// Known container images -> infra classification.
const IMAGE_CLASSES = [
    { pattern: /postgres|mysql|mariadb|sqlite|clickhouse/, archetype: "database" },
    { pattern: /redis|valkey|rabbitmq|kafka|nats/, archetype: "queue" },
    { pattern: /minio|s3/, archetype: "storage" },
    { pattern: /nginx|traefik|caddy|haproxy|envoy/, archetype: "gateway" },
    { pattern: /langfuse|latitude|grafana|prometheus|otel|collector/, archetype: "cloud" },
];

function parseArguments(argv) {
    const positionals = [];
    let outDir;
    let modulesAsBuildings = false;
    let overview = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--out-dir") {
            outDir = argv[i + 1];
            i += 1;
        } else if (argv[i] === "--modules-as-buildings") modulesAsBuildings = true;
        else if (argv[i] === "--overview") overview = true;
        else positionals.push(argv[i]);
    }
    if (!positionals[0]) {
        console.error("Usage: generate-map.mjs <target-repo> [--out-dir path] [--modules-as-buildings]");
        process.exit(2);
    }
    const repo = resolve(positionals[0]);
    return {
        repo,
        outDir: resolve(outDir ?? join("out", overview ? `${basename(repo)}-overview` : basename(repo))),
        modulesAsBuildings,
        overview,
    };
}

// Inventory: prefer `git ls-files` (respects .gitignore, excludes vendored
// checkouts); fall back to a directory walk. Either way, exclude nested git
// repositories (vendored third-party code) and generated/dependency dirs.
function inventory(root) {
    let files;
    if (existsSync(join(root, ".git"))) {
        const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        files = result.status === 0 ? result.stdout.split("\0").filter(Boolean) : null;
    }
    files ??= walk(root);
    const nestedRepos = new Set();
    for (const file of files) {
        const parts = file.split(sep);
        for (let depth = 1; depth < parts.length; depth += 1) {
            const dir = parts.slice(0, depth).join(sep);
            if (!nestedRepos.has(dir) && existsSync(join(root, dir, ".git"))) nestedRepos.add(dir);
        }
    }
    return files
        .filter((f) => ![...nestedRepos].some((dir) => f.startsWith(dir + sep)))
        .filter((f) => !f.split(sep).some((seg) => IGNORED_DIRS.has(seg)))
        .sort();
}

function walk(root) {
    const files = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        // Unreadable dirs (macOS-protected bundles like Photos Library) are
        // skipped rather than crashing the walk.
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") && entry.name !== ".github") continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name) && !existsSync(join(full, ".git"))) stack.push(full);
            } else if (entry.isFile()) {
                files.push(relative(root, full));
            }
        }
    }
    return files.sort();
}

function isTestPath(file) {
    return file.split(sep).some((seg) => TEST_DIRS.has(seg)) || TEST_FILE_PATTERN.test(file);
}

function extensionOf(file) {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot);
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

function readText(path) {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

const { repo, outDir, modulesAsBuildings, overview } = parseArguments(process.argv.slice(2));

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

const packageDirs = allFiles.filter((f) => basename(f) === "package.json").map((f) => dirname(f));

const packages = packageDirs.map((dir) => {
    const json = readJson(join(repo, dir === "." ? "" : dir, "package.json")) ?? {};
    const deps = { ...json.dependencies, ...json.devDependencies };
    const hasBin = json.bin && Object.keys(json.bin).length > 0;
    const isWebApp = ["react", "next", "vinext", "vue", "svelte"].some((d) => deps[d]);
    return {
        dir,
        name: json.name ?? (dir === "." ? basename(repo) : basename(dir)),
        deps,
        role: hasBin ? "cli" : isWebApp ? "web" : "package",
        id: kebab(json.name ?? basename(dir === "." ? repo : dir)),
    };
});

function owningPackage(file) {
    let best = null;
    for (const pkg of packages) {
        if (pkg.dir === "." || file === pkg.dir || file.startsWith(pkg.dir + sep)) {
            if (!best || pkg.dir.length > best.dir.length) best = pkg;
        }
    }
    return best;
}

// --- 3. Rooms -------------------------------------------------------------------
// Room key = first path segment within the package; a dominant segment holding
// most of the package's files (e.g. src/) is expanded one level deeper.

function segmentsFor(pkg) {
    const locals = sourceFiles
        .filter((f) => owningPackage(f) === pkg)
        .map((f) => (pkg.dir === "." ? f : relative(pkg.dir, f)));
    const byFirst = new Map();
    for (const local of locals) {
        const first = local.includes(sep) ? local.split(sep)[0] : "(root)";
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

const packageSegmentation = new Map(packages.map((pkg) => [pkg, segmentsFor(pkg)]));

const rooms = new Map(); // roomId -> { id, pkg, segment, files, loc }
function roomFor(file) {
    const pkg = owningPackage(file);
    if (!pkg) return null;
    const local = pkg.dir === "." ? file : relative(pkg.dir, file);
    const parts = local.split(sep);
    const { dominant } = packageSegmentation.get(pkg);
    let segment;
    if (parts.length === 1) segment = "(root)";
    else if (parts[0] === dominant && parts.length > 2) segment = join(parts[0], parts[1]);
    else segment = parts[0];
    const id = `${pkg.id}-${kebab(segment)}`;
    if (!rooms.has(id)) rooms.set(id, { id, pkg, segment, files: [], loc: 0 });
    return rooms.get(id);
}

for (const file of sourceFiles) {
    const room = roomFor(file);
    if (!room) continue;
    room.files.push(file);
    room.loc += readText(join(repo, file)).split("\n").length;
}

// --- 4. Import scan ---------------------------------------------------------------

const fileToRoom = new Map();
for (const room of rooms.values()) for (const f of room.files) fileToRoom.set(f, room);

function resolveImport(fromFile, specifier) {
    const tryFile = (raw) => {
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
        const pkg = owningPackage(fromFile);
        const hit = tryFile(pkg.dir === "." ? specifier.slice(2) : join(pkg.dir, specifier.slice(2)));
        return hit ? { file: hit } : null;
    }
    const local = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
    if (local) return { pkg: local };
    return { bare: specifier };
}

const IMPORT_PATTERN = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
const fileEdges = []; // { from, to } file-level
const packageEdges = new Map();
const bareImports = new Map();

for (const file of sourceFiles) {
    const fromRoom = fileToRoom.get(file);
    if (!fromRoom) continue;
    const text = readText(join(repo, file));
    for (const match of text.matchAll(IMPORT_PATTERN)) {
        const target = resolveImport(file, match[1]);
        if (!target) continue;
        if (target.file) fileEdges.push({ from: file, to: target.file });
        else if (target.pkg && target.pkg !== fromRoom.pkg) {
            packageEdges.set(`${fromRoom.pkg.id}->${target.pkg.id}`, true);
        } else if (target.bare) {
            if (!bareImports.has(target.bare)) bareImports.set(target.bare, new Set());
            bareImports.get(target.bare).add(fromRoom.pkg.id);
        }
    }
}

const roomEdges = new Map(); // "fromRoom->toRoom" -> count
for (const { from, to } of fileEdges) {
    const a = fileToRoom.get(from);
    const b = fileToRoom.get(to);
    if (a && b && a !== b) {
        const key = `${a.id}->${b.id}`;
        roomEdges.set(key, (roomEdges.get(key) ?? 0) + 1);
    }
}

// --- 4b. Coupling metrics (archunitts-style fan-in/fan-out/instability) -----------
// Utility modules (high fan-in, low fan-out, instability -> 0) are shared
// lib-like leaves: eliminated from the map so buildings keep only their
// coordinator/composer rooms. Coordinators (low in, high out) are retained.

const UTILITY_MIN_FAN_IN = 3;
const UTILITY_MAX_INSTABILITY = 0.25;
const OTLP_PATTERN = /@opentelemetry\/|otlp|OTEL_EXPORTER/i;
// Method-call forms require a database-ish receiver: bare .delete()/.update()
// would match every JavaScript Map and Set.
const DB_WRITE_PATTERN =
    /insert\s+into\s|delete\s+from\s|\bupdate\s+\w+\s+set\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.(?:insert|update|delete|upsert)\s*\(/i;
const DB_READ_PATTERN =
    /\bselect\s[\s\S]{0,80}?\bfrom\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.select\s*\(/i;
const MIGRATION_FILE_PATTERN = /\/migrations\/\d+[-_.][^/]*$/;

// McCabe cyclomatic complexity from the TypeScript compiler API when it is
// installed (per function: 1 + decision points attributed to the innermost
// enclosing function; logical operators and non-default switch cases count;
// top-level statements form an implicit function). A file carries the sum
// and the max function complexity. Falls back to a decision-point regex
// (sum == max, no function attribution) when typescript is unavailable.
let ts = null;
try {
    ts = (await import("typescript")).default;
} catch {
    /* fall back below */
}
const COMPLEXITY_FALLBACK_PATTERN = /\bif\s*\(|\bfor\s*(?:\(|await)|\bwhile\s*\(|\bcase\s|\bcatch\b|&&|\|\||\?\?/g;
const complexityCache = new Map();
function fileComplexityStats(file) {
    if (complexityCache.has(file)) return complexityCache.get(file);
    const text = readText(join(repo, file));
    let stats;
    if (ts) {
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const functionKinds = new Set([
            ts.SyntaxKind.FunctionDeclaration,
            ts.SyntaxKind.FunctionExpression,
            ts.SyntaxKind.ArrowFunction,
            ts.SyntaxKind.MethodDeclaration,
            ts.SyntaxKind.Constructor,
            ts.SyntaxKind.GetAccessor,
            ts.SyntaxKind.SetAccessor,
        ]);
        const decisionKinds = new Set([
            ts.SyntaxKind.IfStatement,
            ts.SyntaxKind.ForStatement,
            ts.SyntaxKind.ForInStatement,
            ts.SyntaxKind.ForOfStatement,
            ts.SyntaxKind.WhileStatement,
            ts.SyntaxKind.DoStatement,
            ts.SyntaxKind.ConditionalExpression,
            ts.SyntaxKind.CatchClause,
            ts.SyntaxKind.CaseClause,
        ]);
        const logicalOperators = new Set([
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
        ]);
        const topLevel = { complexity: 1 };
        const finished = [];
        const stack = [topLevel];
        const visit = (node) => {
            if (functionKinds.has(node.kind)) {
                stack.push({ complexity: 1 });
                ts.forEachChild(node, visit);
                finished.push(stack.pop());
                return;
            }
            if (
                decisionKinds.has(node.kind) ||
                (node.kind === ts.SyntaxKind.BinaryExpression && logicalOperators.has(node.operatorToken?.kind))
            ) {
                stack[stack.length - 1].complexity += 1;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        finished.push(topLevel);
        const values = finished.map((f) => f.complexity);
        stats = { sum: values.reduce((total, v) => total + v, 0), max: Math.max(...values) };
    } else {
        const total = 1 + (text.match(COMPLEXITY_FALLBACK_PATTERN)?.length ?? 0);
        stats = { sum: total, max: total };
    }
    complexityCache.set(file, stats);
    return stats;
}
function fileComplexity(file) {
    return fileComplexityStats(file).sum;
}
function fileMaxFunctionComplexity(file) {
    return fileComplexityStats(file).max;
}

function couplingFromEdges(pairs) {
    const stats = new Map();
    const ensure = (id) => {
        if (!stats.has(id)) stats.set(id, { in: new Set(), out: new Set() });
        return stats.get(id);
    };
    for (const [from, to] of pairs) {
        ensure(from).out.add(to);
        ensure(to).in.add(from);
    }
    return new Map(
        [...stats.entries()].map(([id, s]) => {
            const fanIn = s.in.size;
            const fanOut = s.out.size;
            const instability = fanIn + fanOut === 0 ? 1 : fanOut / (fanIn + fanOut);
            return [id, { in: fanIn, out: fanOut, instability }];
        }),
    );
}

const fileCoupling = couplingFromEdges(fileEdges.map(({ from, to }) => [from, to]));
const roomCoupling = couplingFromEdges([...roomEdges.keys()].map((k) => k.split("->")));

// A significantly coupled file in the middle band (neither leaf nor composer,
// e.g. an annotation-store with in=7 out=4) anchors its module: a room
// containing one is retained even when the room aggregates as a utility.
const MID_MIN_DEGREE = 5;
const MID_INSTABILITY = [0.25, 0.8];

function isMidFile(file) {
    const c = fileCoupling.get(file);
    return Boolean(
        c && c.in + c.out >= MID_MIN_DEGREE && c.instability > MID_INSTABILITY[0] && c.instability < MID_INSTABILITY[1],
    );
}

function isUtilityRoom(roomId) {
    const c = roomCoupling.get(roomId);
    if (!c || c.in < UTILITY_MIN_FAN_IN || c.instability > UTILITY_MAX_INSTABILITY) return false;
    const room = rooms.get(roomId);
    return !room?.files.some(isMidFile);
}

const eliminatedRooms = [...rooms.values()]
    .filter((room) => room.files.length && isUtilityRoom(room.id))
    .map((room) => ({ id: room.id, segment: room.segment, ...roomCoupling.get(room.id) }));

// --- 5. Deployment shape -----------------------------------------------------------

// Minimal indentation-based parse of a compose file's services block.
function parseComposeServices(text) {
    const lines = text.split("\n");
    const services = [];
    let inServices = false;
    let current = null;
    let servicesIndent = -1;
    for (const line of lines) {
        if (/^\s*(#|$)/.test(line)) continue;
        const indent = line.length - line.trimStart().length;
        const key = line.trim();
        if (/^services:\s*$/.test(key) && indent === 0) {
            inServices = true;
            servicesIndent = 0;
            continue;
        }
        if (inServices && indent === servicesIndent && /^\S/.test(line)) {
            inServices = false;
            current = null;
        }
        if (!inServices) continue;
        const serviceMatch = /^([a-zA-Z0-9_-]+):\s*$/.exec(key);
        if (indent === servicesIndent + 2 && serviceMatch) {
            current = { name: serviceMatch[1] };
            services.push(current);
            continue;
        }
        if (!current) continue;
        const image = /^image:\s*(.+)$/.exec(key);
        if (image) current.image = image[1].trim();
        const dockerfile = /^dockerfile:\s*(.+)$/.exec(key);
        if (dockerfile) current.dockerfile = dockerfile[1].trim();
        if (/^ports:\s*$/.test(key)) current.hasPorts = true;
        if (/^depends_on:\s*$/.test(key)) {
            current.dependsOnIndent = indent;
            current.dependsOn ??= [];
            continue;
        }
        if (current.dependsOnIndent !== undefined && indent > current.dependsOnIndent) {
            const dep = /^-\s*([a-zA-Z0-9_-]+)\s*$/.exec(key) ?? /^([a-zA-Z0-9_-]+):\s*$/.exec(key);
            if (dep) current.dependsOn.push(dep[1]);
        } else if (current.dependsOnIndent !== undefined && indent <= current.dependsOnIndent) {
            current.dependsOnIndent = undefined;
        }
    }
    return services;
}

function parseDockerfile(path) {
    const text = readText(join(repo, path));
    const copies = [...text.matchAll(/^COPY\s+([^\s]+)\s/gm)]
        .map((m) => m[1])
        .filter(
            (p) => !p.startsWith("--") && allFiles.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`)),
        );
    const entryMatch = /^(?:ENTRYPOINT|CMD)\s+(\[.*\]|.+)$/m.exec(text);
    let entryFile = null;
    if (entryMatch) {
        const tokens = entryMatch[1].startsWith("[") ? (readJsonSafe(entryMatch[1]) ?? []) : entryMatch[1].split(/\s+/);
        entryFile = tokens.find((t) => typeof t === "string" && fileExists(t)) ?? null;
    }
    return { copies, entryFile };
}

function readJsonSafe(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
function fileExists(p) {
    return allFiles.includes(p);
}

const composeFiles = allFiles.filter((f) => /docker-compose[^/]*\.(yml|yaml)$/.test(basename(f)));
const crontabFiles = allFiles.filter((f) => /^crontab/.test(basename(f)));

// Schedules: service name (from `compose run <svc>`) -> cron expression.
const schedules = new Map();
for (const crontab of crontabFiles) {
    for (const line of readText(join(repo, crontab)).split("\n")) {
        if (/^\s*(#|$)/.test(line)) continue;
        const runMatch = /run\s+(?:--rm\s+)?([a-zA-Z0-9_-]+)/.exec(line);
        const schedule = line.trim().split(/\s+/).slice(0, 5).join(" ");
        if (runMatch) schedules.set(runMatch[1], { schedule, crontab });
    }
}

// Hosts: one per compose file, excluding partial overlays (override/build).
// Name from informative path segments; env variants deduped below, preferring
// prod > uat > example > unqualified > dev.
const GENERIC_SEGMENTS = new Set(["deploy", "deployment", "deployments", "docker", "compose", "infra", "products"]);
const ENV_RANK = [
    [/prod/, 5],
    [/uat|stag/, 4],
    [/example/, 3],
    [/dev/, 1],
];

function hostNameParts(file) {
    const qualifiers = basename(file)
        .replace(/\.ya?ml$/, "")
        .split(".")
        .filter((part) => part && part !== "docker-compose" && part !== "compose");
    const dirParts = dirname(file)
        .split(sep)
        .filter((seg) => seg !== "." && !GENERIC_SEGMENTS.has(seg));
    return [...dirParts, ...qualifiers.filter((q) => !dirParts.includes(q))];
}

function envRank(file) {
    for (const [pattern, rank] of ENV_RANK) if (pattern.test(file)) return rank;
    return 2;
}

const candidateHosts = composeFiles
    .filter((file) => !/\.(override|build)\.ya?ml$/.test(basename(file)))
    .map((file) => {
        const dir = dirname(file);
        const parts = hostNameParts(file).filter((p) => p !== "example");
        const name = parts.join(" ") || "host";
        const services = parseComposeServices(readText(join(repo, file))).map((service) => {
            // Bind service to a Dockerfile: explicit build.dockerfile, or images/<name>.Dockerfile convention.
            let dockerfile = service.dockerfile;
            if (dockerfile && !fileExists(dockerfile)) {
                const relToCompose = join(dir, dockerfile);
                dockerfile = fileExists(relToCompose) ? relToCompose : dockerfile;
            }
            if (!dockerfile) {
                dockerfile = allFiles.find((f) => basename(f) === `${service.name}.Dockerfile`);
            }
            const built = dockerfile && fileExists(dockerfile) ? parseDockerfile(dockerfile) : null;
            const imageClass =
                (service.image && IMAGE_CLASSES.find(({ pattern }) => pattern.test(service.image))?.archetype) ??
                (/database|postgres|mysql|db$/.test(service.name)
                    ? "database"
                    : /redis|queue|broker|kafka/.test(service.name)
                      ? "queue"
                      : /proxy|nginx|ingress/.test(service.name)
                        ? "gateway"
                        : undefined);
            return {
                ...service,
                dockerfile: built ? dockerfile : undefined,
                copies: built?.copies ?? [],
                entryFile: built?.entryFile ?? null,
                schedule: schedules.get(service.name)?.schedule,
                imageClass,
            };
        });
        return { file, name, id: kebab(`host-${name}`), services, rank: envRank(file) };
    });

// Service-level depends_on harvested across ALL compose variants by service
// name, so wiring declared only in a deduped variant (e.g. development) still
// informs the surviving host's edges.
const serviceDependsOn = new Map();
for (const host of candidateHosts) {
    for (const service of host.services) {
        if (!service.dependsOn?.length) continue;
        if (!serviceDependsOn.has(service.name)) serviceDependsOn.set(service.name, new Set());
        for (const dep of service.dependsOn) serviceDependsOn.get(service.name).add(dep);
    }
}

// Dedup environment variants: drop a host when a higher-ranked host covers
// >=50% of its services (same host, different environment projection).
function serviceNames(host) {
    return new Set(host.services.map((s) => s.name));
}
const hosts = candidateHosts.filter((host) => {
    const names = serviceNames(host);
    return !candidateHosts.some((other) => {
        if (other === host) return false;
        const otherNames = serviceNames(other);
        const shared = [...names].filter((n) => otherNames.has(n)).length;
        const covered = names.size > 0 && shared / names.size >= 0.5;
        if (!covered) return false;
        if (other.rank !== host.rank) return other.rank > host.rank;
        return other.file < host.file; // stable tie-break
    });
});

// Wrangler -> an edge host.
const wranglerFile = allFiles.find((f) => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(f));
let edgeHost = null;
if (wranglerFile) {
    const text = readText(join(repo, wranglerFile))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const config = readJsonSafe(text) ?? {};
    const mainMatch = config.main ?? /main\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
    edgeHost = {
        file: wranglerFile,
        name: config.name ?? "worker",
        main: mainMatch ? mainMatch.replace(/^\.\//, "") : null,
        d1: config.d1_databases ?? [],
    };
}

const drizzleConfig = allFiles.find((f) => /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f));

// Embedded databases declared as package dependencies (LanceDB, SQLite,
// DuckDB, Chroma) are deployment shape in both map modes. One entry per
// dependency repo-wide: several manifests declaring the same store share it.
const EMBEDDED_DB_DEPS = [
    [/^@lancedb\//, "LanceDB vector database"],
    [/^chromadb$/, "Chroma vector database"],
    [/^(better-sqlite3|sqlite3)$/, "SQLite database"],
    [/^(duckdb$|@duckdb\/)/, "DuckDB database"],
];
const embeddedDatabases = [];
for (const pkg of packages) {
    for (const dep of Object.keys(pkg.deps ?? {})) {
        const match = EMBEDDED_DB_DEPS.find(([pattern]) => pattern.test(dep));
        if (!match) continue;
        const id = kebab(`infra-${dep}`);
        if (embeddedDatabases.some((db) => db.id === id)) continue;
        const pkgManifest = pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`;
        embeddedDatabases.push({
            id,
            label: match[1],
            depName: dep,
            path: pkgManifest,
            description: `Embedded database (${dep}) declared in ${pkgManifest}.`,
        });
    }
}

// GitHub Actions workflows are deployment shape too: a scheduled or chained
// workflow that runs repo code is a job host (D9). Line-based parse: name,
// cron, workflow_run upstreams, run-step commands.
const workflowFiles = allFiles.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
const ciWorkflows = [];
for (const file of workflowFiles) {
    const text = readText(join(repo, file));
    const lines = text.split("\n");
    const name = (/^name:\s*(.+)$/m.exec(text)?.[1] ?? basename(file).replace(/\.ya?ml$/, ""))
        .trim()
        .replace(/^['"]|['"]$/g, "");
    const cron = /-\s*cron:\s*['"]?([^'"#\n]+)/.exec(text)?.[1]?.trim() ?? null;
    // workflow_run upstreams: inline list (workflows: ['Sync corpus']) or block list.
    const triggeredBy = [];
    const workflowRunIndex = lines.findIndex((line) => /^\s*workflow_run:\s*$/.test(line));
    if (workflowRunIndex >= 0) {
        for (let i = workflowRunIndex + 1; i < lines.length && /^\s+\S/.test(lines[i]); i += 1) {
            const inline = /^\s*workflows:\s*\[([^\]]+)\]/.exec(lines[i]);
            if (inline) {
                triggeredBy.push(...inline[1].split(",").map((w) => w.trim().replace(/^['"]|['"]$/g, "")));
                break;
            }
            if (/^\s*workflows:\s*$/.test(lines[i])) {
                for (let j = i + 1; j < lines.length; j += 1) {
                    const item = /^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(lines[j]);
                    if (!item) break;
                    triggeredBy.push(item[1]);
                }
                break;
            }
        }
    }
    // Run-step commands: inline `run: cmd` and block `run: |` bodies.
    const commands = [];
    for (let i = 0; i < lines.length; i += 1) {
        const runMatch = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
        if (!runMatch) continue;
        const [, indent, rest] = runMatch;
        if (rest && !/^[|>]/.test(rest)) {
            commands.push(rest);
            continue;
        }
        for (let j = i + 1; j < lines.length; j += 1) {
            const bodyIndent = lines[j].length - lines[j].trimStart().length;
            if (lines[j].trim() && bodyIndent <= indent.length) break;
            if (lines[j].trim()) commands.push(lines[j].trim());
        }
    }
    // Repo entry invocations: a command token naming an existing source file,
    // optionally followed by a subcommand word (D10).
    const invocations = [];
    for (const command of commands) {
        const tokens = command.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
        tokens.forEach((token, index) => {
            if (!fileExists(token) || !SOURCE_EXTENSIONS.has(extensionOf(token))) return;
            const next = tokens[index + 1];
            const sub =
                next && /^[a-z][a-z0-9-]*$/.test(next) && !next.startsWith("-") && !fileExists(next) ? next : null;
            if (!invocations.some((inv) => inv.file === token && inv.sub === sub))
                invocations.push({ file: token, sub });
        });
    }
    // Object-storage traffic: aws s3 cp/sync/mv with an s3:// source or
    // destination; an R2 endpoint anywhere in the file names the store (D11).
    const storage = { downloads: false, uploads: false };
    for (const command of commands) {
        const copy = /\bs3\s+(?:cp|sync|mv)\s+(\S+)\s+(\S+)/.exec(command);
        if (!copy) continue;
        const [source, destination] = [copy[1], copy[2]].map((t) => t.replace(/^["']/, ""));
        if (source.startsWith("s3://")) storage.downloads = true;
        if (destination.startsWith("s3://")) storage.uploads = true;
    }
    const storageLabel = /r2\.cloudflarestorage\.com/i.test(text) ? "Cloudflare R2" : "S3 object storage";
    if (cron || triggeredBy.length || invocations.length) {
        ciWorkflows.push({
            file,
            name,
            cron,
            triggeredBy,
            invocations,
            storage: storage.downloads || storage.uploads ? { ...storage, label: storageLabel } : null,
        });
    }
}

// Host config scan: externals, host-to-host forwarding, host-to-service
// forwarding — computed once, used for districts, infra, and edges.
const hostScan = hosts.map((host) => {
    const hostDir = dirname(host.file);
    const hostQualifiers = host.name.split(" ").filter(Boolean);
    const result = { host, externals: [], hostTargets: new Set(), serviceTargets: [], configs: [] };
    const internalNames = new Set(
        [...hosts.flatMap((h) => h.name.split(" ")), ...hosts.flatMap((h) => h.services.map((s) => s.name))]
            .map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ""))
            .filter(Boolean),
    );
    for (const config of allFiles.filter(
        (f) =>
            dirname(f) === hostDir &&
            /\.ya?ml$/.test(f) &&
            !/docker-compose/.test(basename(f)) &&
            hostQualifiers.some((token) => basename(f).includes(token)),
    )) {
        result.configs.push(config);
        const rawLines = readText(join(repo, config)).split("\n");
        rawLines.forEach((line, index) => {
            const envToken = /endpoint:.*\$\{env:([A-Z0-9_]+)\}/.exec(line)?.[1];
            if (!envToken) return;
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
            if (candidate.length >= 4 && !result.externals.some((e) => e.candidate === candidate)) {
                result.externals.push({ candidate, config });
            }
        });
        const exportLines = rawLines
            .filter((l) => /endpoint:|\$\{env:/.test(l))
            .map((l) => l.toLowerCase().replace(/[^a-z0-9]/g, ""));
        for (const other of hosts) {
            if (other === host) continue;
            const distinct = other.name
                .split(" ")
                .filter((t) => t && !hostQualifiers.includes(t))
                .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""));
            if (distinct.length && exportLines.some((l) => distinct.some((t) => l.includes(t)))) {
                result.hostTargets.add(other.name);
            }
            for (const service of other.services) {
                const normalised = service.name.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (normalised.length >= 6 && exportLines.some((l) => l.includes(normalised))) {
                    result.serviceTargets.push({ service, otherHost: other.name, config });
                    result.hostTargets.add(other.name);
                }
            }
        }
    }
    return result;
});

// Host flow bands from the declared forwarding chain: gateway 1, stack 2,
// evaluation 3, ... (band 0 is reserved for producers, externals go behind
// the last host, shared code behind that).
const hostLayer = new Map();
const forwardingHosts = new Set(
    hostScan.flatMap((scan) => (scan.hostTargets.size ? [scan.host.name, ...scan.hostTargets] : [])),
);
for (const scan of hostScan) {
    if (forwardingHosts.has(scan.host.name) && ![...hostScan].some((other) => other.hostTargets.has(scan.host.name))) {
        hostLayer.set(scan.host.name, 0);
    }
}
for (let pass = 0; pass <= hosts.length; pass += 1) {
    let changed = false;
    for (const scan of hostScan) {
        if (!hostLayer.has(scan.host.name)) continue;
        for (const target of scan.hostTargets) {
            const proposed = hostLayer.get(scan.host.name) + 1;
            if ((hostLayer.get(target) ?? -1) < proposed && proposed <= hosts.length) {
                hostLayer.set(target, proposed);
                changed = true;
            }
        }
    }
    if (!changed) break;
}
for (const host of hosts) if (!hostLayer.has(host.name)) hostLayer.set(host.name, 0);

// Files referenced directly from a package.json script command (R1's script
// roots) are declared entry points, whatever they are named. Shared by both
// map modes.
const scriptReferencedFiles = new Set();
for (const pkg of packages) {
    const manifest = readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {};
    for (const command of Object.values(manifest.scripts ?? {})) {
        for (const token of String(command).split(/\s+/)) {
            const clean = token.replace(/^["']|["']$/g, "");
            if (!/[./]/.test(clean) || clean.startsWith("-")) continue;
            const candidate = join(pkg.dir === "." ? "" : pkg.dir, clean);
            if (fileToRoom.has(candidate)) scriptReferencedFiles.add(candidate);
        }
    }
}

// Code coverage: Istanbul coverage-summary.json files under coverage/ dirs
// (repo root or package roots, one suite subdir deep). Suites merge by best
// per-file line coverage; node coverage is line-weighted over its files.
// The coverage dir is I3-ignored for inventory, so this scan targets it
// directly.
const coverageByFile = new Map(); // repo-relative file -> { covered, total, pct }
for (const base of new Set([".", ...packageDirs])) {
    const coverageDir = join(repo, base === "." ? "" : base, "coverage");
    if (!existsSync(coverageDir)) continue;
    let suiteDirs = [];
    try {
        suiteDirs = readdirSync(coverageDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(coverageDir, e.name));
    } catch {
        /* unreadable */
    }
    for (const candidate of [coverageDir, ...suiteDirs].map((dir) => join(dir, "coverage-summary.json"))) {
        if (!existsSync(candidate)) continue;
        for (const [file, stats] of Object.entries(readJson(candidate) ?? {})) {
            if (file === "total") continue;
            const rel = relative(repo, file);
            if (rel.startsWith("..")) continue;
            const lines = stats.lines ?? {};
            const previous = coverageByFile.get(rel);
            if (!previous || (lines.pct ?? 0) > previous.pct) {
                coverageByFile.set(rel, { covered: lines.covered ?? 0, total: lines.total ?? 0, pct: lines.pct ?? 0 });
            }
        }
    }
}
// TSDoc extraction: the first /** */ block that is file-level (only comments
// or whitespace before it) or attached to an export becomes the node's prose.
// First paragraph only, tags dropped, capped at 280 characters.
const docCache = new Map();
function fileDocSummary(file) {
    if (docCache.has(file)) return docCache.get(file);
    const text = readText(join(repo, file));
    let summary = null;
    const match = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(0, 4000));
    if (match) {
        const before = text.slice(0, match.index);
        const fileLevel = /^\s*(?:\/\/[^\n]*\n|\s)*$/.test(before);
        const onExport = /^\s*export\b/.test(text.slice(match.index + match[0].length));
        if (fileLevel || onExport) {
            const paragraph = [];
            for (const raw of match[1].split("\n")) {
                const line = raw.replace(/^\s*\*? ?/, "");
                if (/^@\w/.test(line)) break;
                if (!line.trim() && paragraph.length) break;
                if (line.trim()) paragraph.push(line.trim());
            }
            const joined = paragraph.join(" ").trim();
            if (joined) summary = joined.length > 280 ? `${joined.slice(0, 277)}...` : joined;
        }
    }
    docCache.set(file, summary);
    return summary;
}
// For a multi-file node, prefer the entry-like file's doc.
function docForFiles(files) {
    const ordered = [...files].sort(
        (a, b) =>
            Number(ENTRY_FILE_PATTERN.test(basename(b).replace(/\.[a-z]+$/, ""))) -
            Number(ENTRY_FILE_PATTERN.test(basename(a).replace(/\.[a-z]+$/, ""))),
    );
    for (const file of ordered) {
        const summary = fileDocSummary(file);
        if (summary) return summary;
    }
    return null;
}

function coverageForFiles(files) {
    let covered = 0;
    let total = 0;
    for (const file of files) {
        const entry = coverageByFile.get(file);
        if (entry) {
            covered += entry.covered;
            total += entry.total;
        }
    }
    return total ? Math.round((covered / total) * 1000) / 10 : null;
}

// --- 6b. Dev-tooling detection by reachability ----------------------------------------
// Deployed roots: files baked into service images, Dockerfile entry points,
// the wrangler worker entry, package bin/main files, and web-app entry dirs.
// Script roots: files referenced from package.json scripts commands.
// A room whose files are reachable only from script roots is dev tooling.

function reachableFrom(roots) {
    const importsOf = new Map();
    for (const { from, to } of fileEdges) {
        importsOf.set(from, [...(importsOf.get(from) ?? []), to]);
    }
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length) {
        for (const next of importsOf.get(queue.pop()) ?? []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}

function resolvePathToken(pkgDir, token) {
    const clean = token.replace(/^["']|["']$/g, "");
    if (!/[./]/.test(clean) || clean.startsWith("-")) return null;
    const candidate = join(pkgDir === "." ? "" : pkgDir, clean);
    return fileToRoom.has(candidate) ? candidate : null;
}

// package.json script entries split by naming convention: QA/codebase
// utilities (checks, linting, tests, packaging, doc indexes) versus
// operational tooling (bootstrap, certificates, backfill, deploys).
// A QA keyword in ANY segment of the script name marks it QA
// (tool:test:coverage is QA even though it starts with "tool").
const QA_SCRIPT_PATTERN =
    /(^|[:._-])(check|lint|test|typecheck|coverage|knip|audit|format|fmt|quality|adr|rfc|docs?|prepare|prepack|postinstall|release|clean|proof|prove|uat|spike|poc|bench(mark)?|inventory|crap)([:._-]|$)/i;

const deployRoots = new Set();
const scriptRoots = new Set();
const operationalRoots = new Set();

for (const host of hosts) {
    for (const service of host.services) {
        if (service.entryFile) deployRoots.add(service.entryFile);
        for (const copy of service.copies) {
            for (const f of sourceFiles) if (f.startsWith(`${copy.replace(/\/$/, "")}/`)) deployRoots.add(f);
        }
    }
}
if (edgeHost?.main && fileToRoom.has(edgeHost.main)) deployRoots.add(edgeHost.main);

for (const pkg of packages) {
    const json = readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {};
    for (const binPath of Object.values(json.bin ?? {})) {
        const resolved = resolvePathToken(pkg.dir, String(binPath));
        if (resolved) deployRoots.add(resolved);
    }
    for (const field of ["main", "module"]) {
        const resolved = json[field] && resolvePathToken(pkg.dir, String(json[field]));
        if (resolved) deployRoots.add(resolved);
    }
    if (pkg.role === "web") {
        for (const entryDir of ["app", "pages", "src/app", "src/pages"]) {
            const prefix = pkg.dir === "." ? entryDir : join(pkg.dir, entryDir);
            for (const f of sourceFiles) if (f.startsWith(`${prefix}/`)) deployRoots.add(f);
        }
    }
    for (const [scriptName, command] of Object.entries(json.scripts ?? {})) {
        const qa = QA_SCRIPT_PATTERN.test(scriptName);
        for (const token of String(command).split(/\s+/)) {
            const resolved = resolvePathToken(pkg.dir, token);
            if (!resolved) continue;
            scriptRoots.add(resolved);
            if (!qa) operationalRoots.add(resolved);
        }
    }
}

const deployReachable = reachableFrom(deployRoots);
const scriptReachable = reachableFrom(scriptRoots);
const operationalReachable = reachableFrom(operationalRoots);

// Dev tooling, at file granularity: reachable only from QA-named package.json
// scripts and imported by nothing that deploys. Stripped from rooms before
// assembly so one operational CLI does not shield a directory of QA scripts;
// rooms emptied entirely disappear from the map.
const devToolingWarnings = [];
function isDevToolingFile(f) {
    return !deployReachable.has(f) && scriptReachable.has(f) && !operationalReachable.has(f);
}
for (const room of rooms.values()) {
    const excluded = room.files.filter(isDevToolingFile);
    if (!excluded.length) continue;
    room.files = room.files.filter((f) => !isDevToolingFile(f));
    // A room that lost QA files also sheds its file-level orphans: files
    // referenced by no root whose importers are all themselves stripped are
    // residue of the QA directory (an unwired coverage helper), not operational
    // code. Iterated to a fixed point so residue-importing-residue goes too.
    // OTLP producers stay, as in R3.
    const strippedFiles = new Set(excluded);
    const isQaResidue = (f) =>
        !deployReachable.has(f) &&
        !scriptReachable.has(f) &&
        fileEdges.every(({ from, to }) => to !== f || strippedFiles.has(from)) &&
        !OTLP_PATTERN.test(readText(join(repo, f)));
    const residue = [];
    for (;;) {
        const next = room.files.filter((f) => !strippedFiles.has(f) && isQaResidue(f));
        if (!next.length) break;
        for (const f of next) strippedFiles.add(f);
        residue.push(...next);
    }
    room.files = room.files.filter((f) => !strippedFiles.has(f));
    room.loc = room.files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
    const strippedCount = excluded.length + residue.length;
    devToolingWarnings.push(
        room.files.length
            ? `Dev tooling stripped from ${room.segment}: ${strippedCount} QA-script file${strippedCount === 1 ? "" : "s"} (kept ${room.files.length} operational).`
            : `Dev tooling excluded (reachable only from QA package.json scripts): ${room.segment} (${strippedCount} files).`,
    );
}

// --- Overview mode (--overview) ------------------------------------------------
// A whole-codebase module overview: districts are directories (or packages in
// a multi-package repo), every module is a structure, no edges. Composer
// modules (fan-in 0: CLIs, entries) stand in the front row; supporting
// modules sit behind, smaller, tagged "support". Migrations collapse to one
// leaf. Deployment infra and config-declared externals get one district.
// Height scales with lines of code (unclamped above the minimum); footprint
// scales with a cyclomatic-complexity approximation (decision-point count).
if (overview) {
    // District/module colours baked into map.json; keep in step with the
    // viewer's colour vocabulary in viewer/lib/palette.ts.
    const OVERVIEW_APP_COLOR = "#C77740";
    const OVERVIEW_SHARED_COLOR = "#C79F40";
    const OVERVIEW_INFRA_COLOR = "#283B47";
    // .tsx (UI component) modules stand out from plain .ts. Shares the
    // shared-code gold by decision.
    const OVERVIEW_TSX_COLOR = "#C79F40";
    const activeRooms = [...rooms.values()].filter((r) => r.files.length > 0);
    const pkgsWithRooms = [...new Set(activeRooms.map((r) => r.pkg))];
    const multiPkg = pkgsWithRooms.length > 1;

    // Deploy-host attribution: which hosts does a file ship to (via D3 COPY
    // membership of services built from this repo)?
    const copyDirHosts = new Map(); // dir -> Set(host name)
    for (const host of hosts) {
        for (const service of host.services) {
            if (!service.dockerfile) continue;
            for (const copy of service.copies) {
                const dir = copy.replace(/\/$/, "");
                // A COPY of a whole dominant source root (the dashboard image copying
                // bare `src` for its client bundle) is a packaging convenience, not
                // module attribution: skip dirs coarser than the room granularity.
                if (activeRooms.some((room) => roomDir(room).startsWith(`${dir}/`))) continue;
                if (!copyDirHosts.has(dir)) copyDirHosts.set(dir, new Set());
                copyDirHosts.get(dir).add(host.name);
            }
        }
    }
    const fileHosts = (file) => {
        const result = new Set();
        for (const [dir, hostNames] of copyDirHosts) {
            if (file === dir || file.startsWith(`${dir}/`)) for (const name of hostNames) result.add(name);
        }
        return result;
    };
    const filesHosts = (files) => {
        const result = new Set();
        for (const file of files) for (const name of fileHosts(file)) result.add(name);
        return result;
    };

    // Band order: shared/support strip in front (band 0), then generators,
    // then the host chain, externals behind the last host.
    const SHARED_BAND = 0;
    const PRODUCERS_BAND = 1;
    const hostBand = (name) => 2 + (hostLayer.get(name) ?? 0);
    const maxHostBand = 2 + Math.max(0, ...hostLayer.values());
    const EXTERNALS_BAND = maxHostBand + 1;
    const hostNameForBand = new Map([...hostLayer.entries()].map(([name, layer]) => [2 + layer, name]));
    const bandLabel = (band) =>
        band === SHARED_BAND
            ? "Shared & support"
            : band === PRODUCERS_BAND
              ? "Generators"
              : band === EXTERNALS_BAND
                ? "External systems"
                : hostNameForBand.has(band)
                  ? `${titleCase(hostNameForBand.get(band))} host`
                  : `Strip ${band}`;

    const linesOf = (files) => files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
    const externalFanIn = (files) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(to) && !set.has(from)).length;
    };
    const externalFanOut = (files) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(from) && !set.has(to)).length;
    };
    const moduleIsUtility = (files) => {
        const fanIn = externalFanIn(files);
        const fanOut = externalFanOut(files);
        return fanIn >= 2 && fanOut / (fanIn + fanOut) <= 0.33;
    };
    const roomLabel = (room) =>
        room.segment === "(root)" ? "Top-level files" : titleCase(room.segment.split(sep).join(" / "));
    const fileModuleName = (file) => basename(file).replace(/\.[a-z]+$/, "");

    // A module: { id, label, files, path, support, collapsed }
    const modulesForRoom = (room) => {
        const entries = [];
        // Migration scripts (**/migrations/0001_xxx.ts) collapse to one leaf per
        // migrations directory, wherever they sit in the tree.
        const migrationFiles = room.files.filter((f) => MIGRATION_FILE_PATTERN.test(f));
        const migrationDirs = new Map();
        for (const file of migrationFiles) {
            const dir = dirname(file);
            migrationDirs.set(dir, [...(migrationDirs.get(dir) ?? []), file]);
        }
        for (const [dir, files] of migrationDirs) {
            entries.push({
                id: kebab(`${room.id}-${relative(roomDir(room), dir)}`),
                label: `Migrations (${files.length})`,
                files,
                path: dir,
                support: true,
                collapsed: true,
            });
        }
        // Every remaining file is a module, wherever it sits in the tree —
        // subdirectories (src/lib/configuration, plugins/codex-otlp-traces) are
        // shown as their files, not as buildings. Duplicate names within a
        // district are disambiguated by their subdirectory.
        const rest = room.files.filter((f) => !MIGRATION_FILE_PATTERN.test(f));
        const fileEntries = rest.map((file) => {
            const local = relative(roomDir(room), file).replace(/\.[a-z]+$/, "");
            return {
                id: kebab(`${room.id}-${local}`),
                label: titleCase(basename(local)),
                sublabel: local.includes(sep) ? dirname(local) : null,
                files: [file],
                path: file,
                support: (fileCoupling.get(file)?.in ?? 0) > 0,
            };
        });
        const labelCounts = new Map();
        for (const entry of fileEntries) labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
        for (const entry of fileEntries) {
            if (labelCounts.get(entry.label) > 1 && entry.sublabel) entry.label = `${entry.label} (${entry.sublabel})`;
        }
        return [...entries, ...fileEntries];
    };

    const districts = multiPkg
        ? pkgsWithRooms.map((pkg) => ({
              id: kebab(`${pkg.id}-district`),
              label: titleCase(pkg.name),
              path: pkg.dir,
              modules: activeRooms.filter((r) => r.pkg === pkg).flatMap((room) => modulesForRoom(room)),
          }))
        : activeRooms.map((room) => ({
              id: kebab(`${room.id}-district`),
              label: roomLabel(room),
              path: roomDir(room),
              modules: modulesForRoom(room),
          }));

    // Kebab-casing can flatten distinct paths onto one id (src/local/config vs
    // src-local/config); suffix later collisions rather than emit invalid maps.
    const usedModuleIds = new Set();
    for (const district of districts) {
        for (const m of district.modules) {
            let candidate = m.id;
            for (let n = 2; usedModuleIds.has(candidate); n += 1) candidate = `${m.id}-${n}`;
            m.id = candidate;
            usedModuleIds.add(candidate);
        }
    }

    const overviewNodes = [];
    const allModules = []; // { id, files } for flow-edge classification
    const fileToModule = new Map(); // source file -> module node id (for flow edges)

    // Band per district: single-host code sits in its host's band, OTLP
    // producers in the front band, everything shared or unplaced in the strip.
    for (const district of districts) {
        const hostSet = filesHosts(district.modules.flatMap((m) => m.files));
        const producesOtlp = district.modules.some((m) =>
            m.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f)))),
        );
        district.hosts = [...hostSet];
        district.band =
            hostSet.size === 1
                ? hostBand(district.hosts[0])
                : hostSet.size === 0 && producesOtlp
                  ? PRODUCERS_BAND
                  : SHARED_BAND;
    }
    districts.sort((a, b) => a.band - b.band || a.id.localeCompare(b.id));

    for (const district of districts) {
        if (!district.modules.length) continue;
        const utilityShare = district.modules.filter((m) => moduleIsUtility(m.files)).length / district.modules.length;
        const shared = utilityShare >= 0.6;
        const color = shared ? OVERVIEW_SHARED_COLOR : OVERVIEW_APP_COLOR;
        overviewNodes.push({
            id: district.id,
            label: district.label,
            kind: "scope",
            archetype: "district",
            description: `${shared ? "Shared code" : "Function area"}: ${district.path === "." ? "repository root" : `${district.path}/`} — ${district.modules.length} module${district.modules.length === 1 ? "" : "s"}${district.hosts.length ? ` — deploys to ${district.hosts.join(", ")}` : ""}.`,
            tags: [`band:${bandLabel(district.band)}`],
            display: { color, flowLayer: district.band },
        });
        // Files in the same directory sit adjacent on the map: placement order is
        // the path, carried to the viewer as display.flowOrder.
        const placementOrder = new Map(
            [...district.modules].sort((a, b) => a.path.localeCompare(b.path)).map((m, index) => [m.id, index]),
        );
        for (const m of district.modules) {
            const moduleHostTags = [...filesHosts(m.files)].map((name) => `host:${name}`);
            const loc = linesOf(m.files);
            // Complexity is the worst single function in the module: a big module
            // of simple functions should not outscore one gnarly function.
            const complexity = Math.max(...m.files.map((f) => fileMaxFunctionComplexity(f)));
            const height = Math.max(0.6, 0.55 + Math.min(loc, 1500) / 320);
            // Floor area is complexity alone: equal complexity reads as equal
            // footprint whether the module is a composer or support (the ziggurat
            // shape and height already distinguish them).
            // Ceiling 2.5: at the viewer's 80% render scale that equals the 2.0
            // layout step, so even max-complexity buildings cannot overlap.
            const footprint = Math.min(2.5, Math.max(0.95, 0.85 + Math.sqrt(complexity) / 4));
            const asBuilding = m.files.length >= 2 && !m.collapsed;
            // Same classification as the deployment map: entry modules are gateways
            // (entry points), everything else a worker. At file granularity the
            // entry name may be the file itself — exactly cli/cmd/main, or the
            // *-cli / *-command suffix convention (redeploy-cli.ts,
            // delivery-command.ts). Bare api.ts stays a worker: usually a
            // client/types module, not an entry.
            // A file referenced from a package.json script is a DECLARED entry,
            // whatever its name. Name-based entries (entry dirs, *-cli/*-command
            // suffixes) only qualify as composers: an imported *-command file (a
            // shared configured-command helper) is plumbing, not an entry.
            const isEntryModule =
                m.files.some((f) => scriptReferencedFiles.has(f)) ||
                (!m.support &&
                    (m.path.split(sep).some((seg) => ENTRY_DIR_NAMES.has(seg)) ||
                        ENTRY_FILE_PATTERN.test(basename(m.path).replace(/\.[a-z]+$/, ""))));
            overviewNodes.push({
                id: m.id,
                label: m.label,
                kind: "module",
                archetype: asBuilding ? "building" : isEntryModule ? "gateway" : "worker",
                parentId: district.id,
                // TSDoc prose only — the stats live in metrics and render in the
                // panel's Stats section.
                ...(docForFiles(m.files) ? { description: docForFiles(m.files) } : {}),
                ...(isEntryModule ? { attributes: { "entry-point": m.path } } : {}),
                sourceRefs: [{ path: m.path }],
                metrics: {
                    loc,
                    complexity,
                    files: m.files.length,
                    ...(coverageForFiles(m.files) !== null ? { coverage: coverageForFiles(m.files) } : {}),
                },
                tags: [m.support ? "support" : "composer", ...moduleHostTags],
                display: {
                    size: [footprint, height * (m.support ? 0.85 : 1), footprint * 0.85],
                    color: m.files.every((f) => f.endsWith(".tsx")) ? OVERVIEW_TSX_COLOR : color,
                    flowLayer: m.support ? 1 : 0,
                    flowOrder: placementOrder.get(m.id),
                },
            });
            for (const file of m.files) fileToModule.set(file, m.id);
            allModules.push({ id: m.id, files: m.files });
            if (asBuilding) {
                for (const file of m.files) {
                    const fileLoc = linesOf([file]);
                    overviewNodes.push({
                        id: kebab(`${m.id}-${relative(m.path, file).replace(/\.[a-z]+$/, "")}`),
                        label: titleCase(fileModuleName(file)),
                        kind: "module",
                        archetype: "room",
                        parentId: m.id,
                        description: `Source file ${file}: ${fileLoc} lines, complexity ${fileComplexity(file)}.`,
                        sourceRefs: [{ path: file }],
                        metrics: { loc: fileLoc, complexity: fileComplexity(file) },
                    });
                }
            }
        }
    }

    // Infrastructure & external systems: image-only compose services (databases,
    // collectors), config-declared external receivers, wrangler, drizzle.
    const infraMembers = [];
    const overviewEdges = [];
    const addOverviewEdge = (edge) => {
        if (!overviewEdges.some((e) => e.id === edge.id)) overviewEdges.push(edge);
    };
    const infraCollectorFor = (host) => {
        const candidates = host.services.filter((s) => !s.dockerfile);
        const pick = candidates.find((s) => /collector|gateway|ingest/.test(s.name)) ?? candidates[0];
        return pick ? kebab(`infra-${host.name}-${pick.name}`) : null;
    };
    // Per-host infrastructure: services and backing stores sit in their host's
    // district (and band), so postgres lives beside the evaluation modules.
    // Externals get their own district behind the last host.
    for (const scan of hostScan) {
        const host = scan.host;
        for (const service of host.services) {
            if (service.dockerfile) continue; // built from this repo's modules
            infraMembers.push({
                id: kebab(`infra-${host.name}-${service.name}`),
                label: titleCase(service.name),
                archetype: service.imageClass ?? "cloud",
                kind: "infra",
                description: `${service.image ?? "container"} on the ${host.name} host.`,
                path: host.file,
                hostName: host.name,
            });
        }
        const from = infraCollectorFor(host);
        for (const { candidate, config } of scan.externals) {
            const externalId = kebab(`external-${candidate}`);
            infraMembers.push({
                id: externalId,
                label: titleCase(candidate),
                archetype: "cloud",
                kind: "external",
                description: `External receiver declared in ${config}.`,
                path: config,
                external: true,
            });
            if (from) {
                addOverviewEdge({
                    id: `${from}--${externalId}`,
                    from,
                    to: externalId,
                    kind: "data_flow",
                    evidence: "declared",
                    label: "OTLP export",
                    sourceRefs: [{ path: config }],
                });
            }
        }
        if (from) {
            for (const target of scan.hostTargets) {
                const other = hosts.find((h) => h.name === target);
                const to = other ? infraCollectorFor(other) : null;
                if (to) {
                    addOverviewEdge({
                        id: `${from}--${to}`,
                        from,
                        to,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: scan.configs[0] }],
                    });
                }
            }
            for (const { service, config } of scan.serviceTargets) {
                const targetModule = service.entryFile ? fileToModule.get(service.entryFile) : null;
                if (targetModule) {
                    addOverviewEdge({
                        id: `${from}--${targetModule}`,
                        from,
                        to: targetModule,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: config }],
                    });
                }
            }
        }
    }
    // Backing stores that only exist in deduped compose variants (the dev
    // compose's postgres container) are attributed to the surviving host that
    // shares that variant's services.
    for (const candidate of candidateHosts) {
        for (const service of candidate.services) {
            if (["database", "queue", "storage"].includes(service.imageClass) && !service.dockerfile) {
                const variantServiceNames = new Set(candidate.services.map((s) => s.name));
                const owner = hosts.find((h) => h.services.some((s) => variantServiceNames.has(s.name)));
                infraMembers.push({
                    id: kebab(`infra-${service.name}`),
                    label: titleCase(service.name),
                    archetype: service.imageClass,
                    kind: "infra",
                    description: `${service.image ?? "container"} declared in ${candidate.file}.`,
                    path: candidate.file,
                    hostName: owner?.name,
                });
            }
        }
    }
    if (edgeHost)
        infraMembers.push({
            id: "infra-cloudflare-worker",
            label: "Cloudflare Worker",
            archetype: "worker",
            kind: "infra",
            description: `Declared in ${edgeHost.file}.`,
            path: edgeHost.file,
        });
    if (drizzleConfig)
        infraMembers.push({
            id: "infra-drizzle-database",
            label: "Database",
            archetype: "database",
            kind: "infra",
            description: `Declared in ${drizzleConfig}.`,
            path: drizzleConfig,
        });
    const embeddedDbMembers = embeddedDatabases.map((db) => ({
        id: db.id,
        label: db.label,
        archetype: "database",
        kind: "infra",
        description: db.description,
        path: db.path,
        depName: db.depName,
    }));
    infraMembers.push(...embeddedDbMembers);
    const seenInfra = new Set();
    const uniqueInfra = infraMembers.filter((m) => !seenInfra.has(m.id) && seenInfra.add(m.id));
    const infraDistricts = new Map();
    for (const m of uniqueInfra) {
        const key = m.external
            ? "external-systems"
            : m.hostName
              ? kebab(`host-${m.hostName}`)
              : "infrastructure-district";
        if (!infraDistricts.has(key)) {
            infraDistricts.set(key, {
                id: key,
                label: m.external
                    ? "External systems"
                    : m.hostName
                      ? `${titleCase(m.hostName)} host`
                      : "Infrastructure",
                band: m.external ? EXTERNALS_BAND : m.hostName ? hostBand(m.hostName) : SHARED_BAND,
                members: [],
            });
        }
        infraDistricts.get(key).members.push(m);
    }
    for (const infraDistrict of [...infraDistricts.values()].sort((a, b) => a.band - b.band)) {
        overviewNodes.push({
            id: infraDistrict.id,
            label: infraDistrict.label,
            kind: "scope",
            archetype: "district",
            description: `${infraDistrict.label}: ${infraDistrict.members.length} node${infraDistrict.members.length === 1 ? "" : "s"}.`,
            tags: [`band:${bandLabel(infraDistrict.band)}`],
            display: { color: OVERVIEW_INFRA_COLOR, flowLayer: infraDistrict.band },
        });
        for (const m of infraDistrict.members) {
            overviewNodes.push({
                id: m.id,
                label: m.label,
                kind: m.kind,
                archetype: m.archetype,
                parentId: infraDistrict.id,
                description: m.description,
                sourceRefs: [{ path: m.path }],
                ...(m.hostName ? { tags: [`host:${m.hostName}`] } : {}),
                display: { color: OVERVIEW_INFRA_COLOR },
            });
        }
    }

    // Remaining data-flow edges: OTLP producers into the gateway collector, and
    // database reads/writes.
    const otlpTarget =
        uniqueInfra.find((m) => /collector/.test(m.id) && /gateway/.test(m.id)) ??
        uniqueInfra.find((m) => /collector/.test(m.id));
    const databaseTarget = uniqueInfra.find((m) => m.archetype === "database");
    for (const m of allModules) {
        const texts = m.files.map((f) => readText(join(repo, f)));
        if (otlpTarget && texts.some((t) => OTLP_PATTERN.test(t))) {
            addOverviewEdge({
                id: `${m.id}--${otlpTarget.id}`,
                from: m.id,
                to: otlpTarget.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "OTLP export",
            });
        }
        if (databaseTarget && m.id !== databaseTarget.id) {
            if (texts.some((t) => DB_WRITE_PATTERN.test(t))) {
                addOverviewEdge({
                    id: `${m.id}--${databaseTarget.id}-w`,
                    from: m.id,
                    to: databaseTarget.id,
                    kind: "data_flow",
                    evidence: "inferred",
                    confidence: 0.75,
                    label: "writes",
                });
            }
            if (texts.some((t) => DB_READ_PATTERN.test(t))) {
                addOverviewEdge({
                    id: `${databaseTarget.id}--${m.id}-r`,
                    from: databaseTarget.id,
                    to: m.id,
                    kind: "data_flow",
                    evidence: "inferred",
                    confidence: 0.75,
                    label: "reads",
                });
            }
        }
    }
    // Modules importing an embedded database's SDK read/write that database.
    for (const db of embeddedDbMembers) {
        const escaped = db.depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const importPattern = new RegExp(`(from\\s+|require\\()["']${escaped}`);
        for (const m of allModules) {
            if (m.files.some((f) => importPattern.test(readText(join(repo, f))))) {
                addOverviewEdge({
                    id: `${m.id}--${db.id}-u`,
                    from: m.id,
                    to: db.id,
                    kind: "data_flow",
                    evidence: "inferred",
                    confidence: 0.7,
                    label: "reads/writes",
                    sourceRefs: [{ path: db.path }],
                });
            }
        }
    }
    // Modules that reference an external by SDK import or env-var prefix
    // deliver data to it (src/delivery pushing scores into Langfuse/Latitude).
    for (const external of uniqueInfra.filter((m) => m.external)) {
        const name = external.label.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (name.length < 4) continue;
        const referencePattern = new RegExp(`from\\s+["'][^"']*${name}|\\b${name.toUpperCase()}_[A-Z]`);
        for (const m of allModules) {
            if (m.files.some((f) => referencePattern.test(readText(join(repo, f))))) {
                addOverviewEdge({
                    id: `${m.id}--${external.id}-d`,
                    from: m.id,
                    to: external.id,
                    kind: "data_flow",
                    evidence: "inferred",
                    confidence: 0.6,
                    label: "delivers",
                });
            }
        }
    }

    // Import edges, aggregated per module pair. The viewer never draws these
    // at rest — they appear only when a node is selected — so they cost map
    // size, not visual noise.
    const importCounts = new Map();
    for (const { from, to } of fileEdges) {
        const a = fileToModule.get(from);
        const b = fileToModule.get(to);
        if (!a || !b || a === b) continue;
        importCounts.set(`${a}->${b}`, (importCounts.get(`${a}->${b}`) ?? 0) + 1);
    }
    for (const [key, count] of importCounts) {
        const [from, to] = key.split("->");
        addOverviewEdge({
            id: `${from}--${to}-i`,
            from,
            to,
            kind: "depends_on",
            evidence: "declared",
            label: `${count} import${count === 1 ? "" : "s"}`,
        });
    }

    const emittedOverviewIds = new Set(overviewNodes.map((n) => n.id));
    const finalOverviewEdges = overviewEdges.filter(
        (e) => emittedOverviewIds.has(e.from) && emittedOverviewIds.has(e.to),
    );

    const overviewMap = {
        schemaVersion: 1,
        id: kebab(`${basename(repo)}-overview`),
        name: `${titleCase(basename(repo))} overview`,
        repository: repo,
        summary: "Module overview: every module as a structure, grouped by directory; no dependency edges.",
        generatedAt: new Date().toISOString(),
        nodes: overviewNodes,
        edges: finalOverviewEdges,
        warnings: [
            "Overview mode: orphan exclusion is intentionally skipped; QA-only dev tooling is stripped as in the deployment map.",
            ...devToolingWarnings,
            "Only data-flow edges are shown; import dependencies are omitted by design.",
            "Shared-code districts (>=60% high fan-in / low fan-out modules) are coloured differently.",
            "Complexity is the module's worst single function (McCabe-style decision-point count), not a module-wide sum.",
        ],
    };
    const overviewMermaidId = (id) => id.replace(/[^a-zA-Z0-9_]/g, "_");
    const overviewMermaid = [
        `# ${overviewMap.name}`,
        "",
        "```mermaid",
        "flowchart TB",
        ...overviewNodes
            .filter((n) => n.kind === "scope")
            .flatMap((scope) => [
                `  subgraph ${overviewMermaidId(scope.id)}["${scope.label}${scope.description.startsWith("Shared") ? " (shared code)" : ""}"]`,
                ...overviewNodes
                    .filter((n) => n.parentId === scope.id)
                    .map(
                        (n) =>
                            `    ${overviewMermaidId(n.id)}["${n.label}<br/><i>${n.metrics ? `${n.metrics.loc} loc, cx ${n.metrics.complexity}` : n.archetype}</i><br/>${(n.sourceRefs?.[0]?.path ?? "").replace(/"/g, "'")}"]`,
                    ),
                "  end",
            ]),
        "```",
    ].join("\n");
    await writeFile(join(outDir, "map.json"), `${JSON.stringify(overviewMap, null, 2)}\n`);
    await writeFile(join(outDir, "map.md"), `${overviewMermaid}\n`);
    console.log(`Wrote ${outDir}/map.json + map.md (overview mode)`);
    console.log(`districts=${districts.length + (uniqueInfra.length ? 1 : 0)} nodes=${overviewNodes.length}`);
    process.exit(0);
}

// --- 6. Flow layering helper --------------------------------------------------------

function layerByLongestPath(ids, edges, entries) {
    const layers = new Map();
    for (const id of entries.length ? entries : ids) layers.set(id, 0);
    for (let pass = 0; pass < ids.length + 1; pass += 1) {
        let changed = false;
        for (const key of edges.keys()) {
            const [from, to] = key.split("->");
            if (!layers.has(from) || !ids.includes(to)) continue;
            const proposed = layers.get(from) + 1;
            if ((!layers.has(to) || layers.get(to) < proposed) && proposed <= ids.length) {
                layers.set(to, proposed);
                changed = true;
            }
        }
        if (!changed) break;
    }
    for (const id of ids) if (!layers.has(id)) layers.set(id, 0);
    return layers;
}

// --- 6c. Cross-package path references --------------------------------------------
// A string literal in one package's code that resolves into another area's
// directory (e.g. the CLI bundling "../../skills/map-codebase") is a declared
// dependency: the referenced area is reassigned to the referencing package's
// district.
const pathReassignments = new Map(); // roomId -> { pkg, fromFile }
for (const file of sourceFiles) {
    const text = readText(join(repo, file));
    const fromPkg = owningPackage(file);
    // Plain relative imports are ordinary dependencies (S3 edges), not area
    // claims: a root-package QA script importing ../tools/x/src/core must not
    // steal the room. Only non-import path literals reassign.
    const importSpecifiers = new Set([...text.matchAll(IMPORT_PATTERN)].map((m) => m[1]));
    for (const match of text.matchAll(/["']((?:\.\.\/)+[^"'\n]+)["']/g)) {
        if (importSpecifiers.has(match[1])) continue;
        // The literal may be relative to the file's directory or to the package
        // root (the `resolve(packageRoot, "...")` idiom): try both bases.
        const bases = [dirname(file), fromPkg?.dir ?? "."];
        for (const base of bases) {
            const resolved = join(base === "." ? "" : base, match[1]);
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

// --- 7. Assemble the map --------------------------------------------------------------

const nodes = [];
const edges = [];
const warnings = [
    "Generated by the deterministic prototype: names and descriptions are mechanical, not semantic.",
    "Test directories and *.test/*.spec files are excluded.",
    `Shared utility modules (fan-in >= ${UTILITY_MIN_FAN_IN}, instability <= ${UTILITY_MAX_INSTABILITY}) are eliminated: ${eliminatedRooms.map((r) => r.segment).join(", ") || "none"}.`,
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

// The repository-relative directory a room represents ("(root)" -> package dir).
function roomDir(room) {
    if (room.segment === "(root)") return room.pkg.dir === "." ? "." : room.pkg.dir;
    return room.pkg.dir === "." ? room.segment : join(room.pkg.dir, room.segment);
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
    thresholds: { utilityMinFanIn: UTILITY_MIN_FAN_IN, utilityMaxInstability: UTILITY_MAX_INSTABILITY },
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
