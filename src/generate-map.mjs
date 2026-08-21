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

import { readdirSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".wrangler",
  ".turbo", "out", "vendor", ".venv", "__pycache__", ".functionary", ".repo-city",
  "generated", "docs",
]);
// Codebase/dev utilities are detected by reachability, not by name: code
// reachable only from package.json scripts and imported by nothing that
// deploys is excluded from the map (see section 6b).
const TEST_DIRS = new Set(["test", "tests", "__tests__", "test-database", "testing"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ENTRY_DIR_NAMES = new Set(["bin", "app", "pages", "routes", "cmd", "cli", "api"]);

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
    if (argv[i] === "--out-dir") { outDir = argv[i + 1]; i += 1; }
    else if (argv[i] === "--modules-as-buildings") modulesAsBuildings = true;
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
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
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
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function kebab(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function titleCase(text) {
  return text.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const { repo, outDir, modulesAsBuildings, overview } = parseArguments(process.argv.slice(2));

// Experimental (--modules-as-buildings): every module node with >=2 files
// becomes a building whose rooms are its files — a preview of "buildings
// depict modules" while the room semantics are still undecided.
function pushFileRooms(parentId, files) {
  for (const file of files) {
    const name = basename(file).replace(/\.[a-z]+$/, "");
    nodes.push({
      id: kebab(`${parentId}-${name}`),
      label: titleCase(name),
      kind: "module", archetype: "room", parentId,
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
const CONFIG_FILE_PATTERN = /(?:^|\/)(?:[\w.-]*\.config\.(?:ts|js|mjs|cjs)|[\w.-]*-setup\.(?:ts|js|mjs)|\.\w+rc\.(?:js|cjs))$/;
const sourceFiles = allFiles.filter(
  (f) => SOURCE_EXTENSIONS.has(extensionOf(f)) && !isTestPath(f) && !CONFIG_FILE_PATTERN.test(f),
);

// --- 2. Packages ----------------------------------------------------------------

const packageDirs = allFiles
  .filter((f) => basename(f) === "package.json")
  .map((f) => dirname(f));

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
  const dominant = [...byFirst.entries()].find(([seg, count]) =>
    seg !== "(root)" && count / locals.length > 0.6 &&
    locals.some((l) => l.startsWith(seg + sep) && l.split(sep).length > 2));
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
    const candidates = [raw, `${raw}.ts`, `${raw}.tsx`, `${raw}.js`, `${raw}.mjs`,
      join(raw, "index.ts"), join(raw, "index.js")];
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
const DB_WRITE_PATTERN = /insert\s+into\s|delete\s+from\s|\bupdate\s+\w+\s+set\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.(?:insert|update|delete|upsert)\s*\(/i;
const DB_READ_PATTERN = /\bselect\s[\s\S]{0,80}?\bfrom\b|\b(?:db|database|sql|pool|client|store|repository|tx|trx|knex|drizzle)\w*\.select\s*\(/i;
const MIGRATION_FILE_PATTERN = /\/migrations\/\d+[-_.][^/]*$/;

// McCabe cyclomatic complexity from the TypeScript compiler API when it is
// installed (per function: 1 + decision points, logical operators and
// non-default switch cases included, nested functions counted separately;
// file complexity is the sum). Falls back to a decision-point regex when the
// typescript package is unavailable.
let ts = null;
try { ts = (await import("typescript")).default; } catch { /* fall back below */ }
const COMPLEXITY_FALLBACK_PATTERN = /\bif\s*\(|\bfor\s*(?:\(|await)|\bwhile\s*\(|\bcase\s|\bcatch\b|&&|\|\||\?\?/g;
const complexityCache = new Map();
function fileComplexity(file) {
  if (complexityCache.has(file)) return complexityCache.get(file);
  const text = readText(join(repo, file));
  let complexity;
  if (ts) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const functionKinds = new Set([
      ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
      ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
      ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
    ]);
    const decisionKinds = new Set([
      ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement,
      ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
      ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.CatchClause, ts.SyntaxKind.CaseClause,
    ]);
    const logicalOperators = new Set([
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ]);
    let functions = 0;
    let decisions = 0;
    const visit = (node) => {
      if (functionKinds.has(node.kind)) functions += 1;
      else if (decisionKinds.has(node.kind)) decisions += 1;
      else if (node.kind === ts.SyntaxKind.BinaryExpression && logicalOperators.has(node.operatorToken?.kind)) decisions += 1;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    complexity = Math.max(1, functions) + decisions;
  } else {
    complexity = 1 + (text.match(COMPLEXITY_FALLBACK_PATTERN)?.length ?? 0);
  }
  complexityCache.set(file, complexity);
  return complexity;
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
  return new Map([...stats.entries()].map(([id, s]) => {
    const fanIn = s.in.size;
    const fanOut = s.out.size;
    const instability = fanIn + fanOut === 0 ? 1 : fanOut / (fanIn + fanOut);
    return [id, { in: fanIn, out: fanOut, instability }];
  }));
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
  return Boolean(c && c.in + c.out >= MID_MIN_DEGREE
    && c.instability > MID_INSTABILITY[0] && c.instability < MID_INSTABILITY[1]);
}

function isUtilityRoom(roomId) {
  const c = roomCoupling.get(roomId);
  if (!c || c.in < UTILITY_MIN_FAN_IN || c.instability > UTILITY_MAX_INSTABILITY) return false;
  const room = rooms.get(roomId);
  return !room || !room.files.some(isMidFile);
}

const eliminatedRooms = [...rooms.values()]
  .filter((room) => room.files.length && isUtilityRoom(room.id))
  .map((room) => ({ id: room.id, segment: room.segment, ...roomCoupling.get(room.id) }));
const eliminatedRoomIds = new Set(eliminatedRooms.map((r) => r.id));


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
    if (/^services:\s*$/.test(key) && indent === 0) { inServices = true; servicesIndent = 0; continue; }
    if (inServices && indent === servicesIndent && /^\S/.test(line)) { inServices = false; current = null; }
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
    if (/^depends_on:\s*$/.test(key)) { current.dependsOnIndent = indent; current.dependsOn ??= []; continue; }
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
    .filter((p) => !p.startsWith("--") && allFiles.some((f) => f === p || f.startsWith(p.replace(/\/$/, "") + "/")));
  const entryMatch = /^(?:ENTRYPOINT|CMD)\s+(\[.*\]|.+)$/m.exec(text);
  let entryFile = null;
  if (entryMatch) {
    const tokens = entryMatch[1].startsWith("[")
      ? (readJsonSafe(entryMatch[1]) ?? [])
      : entryMatch[1].split(/\s+/);
    entryFile = tokens.find((t) => typeof t === "string" && fileExists(t)) ?? null;
  }
  return { copies, entryFile };
}

function readJsonSafe(text) { try { return JSON.parse(text); } catch { return undefined; } }
function fileExists(p) { return allFiles.includes(p); }

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
const GENERIC_SEGMENTS = new Set(["deploy", "deployment", "deployments", "docker", "compose", "infra"]);
const ENV_RANK = [
  [/prod/, 5], [/uat|stag/, 4], [/example/, 3], [/dev/, 1],
];

function hostNameParts(file) {
  const qualifiers = basename(file)
    .replace(/\.ya?ml$/, "")
    .split(".")
    .filter((part) => part && part !== "docker-compose" && part !== "compose");
  const dirParts = dirname(file).split(sep).filter((seg) => seg !== "." && !GENERIC_SEGMENTS.has(seg));
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
      (service.image && IMAGE_CLASSES.find(({ pattern }) => pattern.test(service.image))?.archetype)
      ?? (/database|postgres|mysql|db$/.test(service.name) ? "database"
        : /redis|queue|broker|kafka/.test(service.name) ? "queue"
        : /proxy|nginx|ingress/.test(service.name) ? "gateway"
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
function serviceNames(host) { return new Set(host.services.map((s) => s.name)); }
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
  const text = readText(join(repo, wranglerFile)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

// --- Overview mode (--overview) ------------------------------------------------
// A whole-codebase module overview: districts are directories (or packages in
// a multi-package repo), every module is a structure, no edges. Composer
// modules (fan-in 0: CLIs, entries) stand in the front row; supporting
// modules sit behind, smaller, tagged "support". Migrations collapse to one
// leaf. Deployment infra and config-declared externals get one district.
// Height scales with lines of code (unclamped above the minimum); footprint
// scales with a cyclomatic-complexity approximation (decision-point count).
if (overview) {
  const OVERVIEW_APP_COLOR = "#6d9da5";
  const OVERVIEW_SHARED_COLOR = "#8f7da8";
  const OVERVIEW_INFRA_COLOR = "#b77f8b";
  const activeRooms = [...rooms.values()].filter((r) => r.files.length > 0);
  const pkgsWithRooms = [...new Set(activeRooms.map((r) => r.pkg))];
  const multiPkg = pkgsWithRooms.length > 1;

  const linesOf = (files) => files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
  const complexityOf = (files) => files.reduce((sum, f) => sum + fileComplexity(f), 0);
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
  const roomLabel = (room) => room.segment === "(root)"
    ? "Top-level files"
    : titleCase(room.segment.split(sep).join(" / "));
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
        files, path: dir, support: true, collapsed: true,
      });
    }
    const strippedRoom = { ...room, files: room.files.filter((f) => !MIGRATION_FILE_PATTERN.test(f)) };
    const children = childRoomsOf(strippedRoom);
    const pushFileModule = (file) => entries.push({
      id: kebab(`${room.id}-${fileModuleName(file)}`),
      label: titleCase(fileModuleName(file)),
      files: [file], path: file,
      support: (fileCoupling.get(file)?.in ?? 0) > 0,
    });
    if (!children.length) {
      strippedRoom.files.forEach(pushFileModule);
      return entries;
    }
    for (const child of children) {
      if (child.seg === "(files)") {
        child.files.forEach(pushFileModule); // dissolve the support bucket
      } else if (child.files.length === 1) {
        pushFileModule(child.files[0]);
      } else {
        entries.push({
          id: kebab(`${room.id}-${child.seg}`), label: titleCase(child.seg),
          files: child.files, path: join(roomDir(room), child.seg),
          support: externalFanIn(child.files) > 0,
        });
      }
    }
    return entries;
  };

  const districts = multiPkg
    ? pkgsWithRooms.map((pkg) => ({
        id: kebab(`${pkg.id}-district`), label: titleCase(pkg.name), path: pkg.dir,
        modules: activeRooms.filter((r) => r.pkg === pkg).flatMap((room) =>
          activeRooms.filter((x) => x.pkg === pkg).length > 4
            ? [{ id: room.id, label: roomLabel(room), files: room.files, path: roomDir(room),
                support: externalFanIn(room.files) > 0 }]
            : modulesForRoom(room)),
      }))
    : activeRooms.map((room) => ({
        id: kebab(`${room.id}-district`), label: roomLabel(room), path: roomDir(room),
        modules: modulesForRoom(room),
      }));

  const overviewNodes = [];
  const allModules = []; // { id, files } for flow-edge classification
  const fileToModule = new Map(); // source file -> module node id (for flow edges)
  for (const district of districts) {
    if (!district.modules.length) continue;
    const utilityShare = district.modules.filter((m) => moduleIsUtility(m.files)).length / district.modules.length;
    const shared = utilityShare >= 0.6;
    const color = shared ? OVERVIEW_SHARED_COLOR : OVERVIEW_APP_COLOR;
    overviewNodes.push({
      id: district.id, label: district.label, kind: "scope", archetype: "district",
      description: `${shared ? "Shared code" : "Function area"}: ${district.path === "." ? "repository root" : district.path + "/"} — ${district.modules.length} module${district.modules.length === 1 ? "" : "s"}.`,
      display: { color },
    });
    for (const m of district.modules) {
      const loc = linesOf(m.files);
      const complexity = complexityOf(m.files);
      const height = Math.max(0.6, 0.55 + loc / 320);
      const footprint = Math.min(3.4, Math.max(0.95, 0.85 + Math.sqrt(complexity) / 7));
      const scale = m.support ? 0.72 : 1;
      const asBuilding = m.files.length >= 2 && !m.collapsed;
      overviewNodes.push({
        id: m.id, label: m.label, kind: "module",
        archetype: asBuilding ? "building" : "worker",
        parentId: district.id,
        description: `${m.files.length} source file${m.files.length === 1 ? "" : "s"}, ${loc} lines, complexity ~${complexity}.`,
        sourceRefs: [{ path: m.path }],
        metrics: { loc, complexity, files: m.files.length },
        tags: m.support ? ["support"] : ["composer"],
        display: {
          size: [footprint * scale, height * (m.support ? 0.85 : 1), footprint * 0.85 * scale],
          color,
          flowLayer: m.support ? 1 : 0,
        },
      });
      for (const file of m.files) fileToModule.set(file, m.id);
      allModules.push({ id: m.id, files: m.files });
      if (asBuilding) {
        for (const file of m.files) {
          const fileLoc = linesOf([file]);
          overviewNodes.push({
            id: kebab(`${m.id}-${fileModuleName(file)}`), label: titleCase(fileModuleName(file)),
            kind: "module", archetype: "room", parentId: m.id,
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
  const addOverviewEdge = (edge) => { if (!overviewEdges.some((e) => e.id === edge.id)) overviewEdges.push(edge); };
  const infraCollectorFor = (host) => {
    const candidates = host.services.filter((s) => !s.dockerfile);
    const pick = candidates.find((s) => /collector|gateway|ingest/.test(s.name)) ?? candidates[0];
    return pick ? kebab(`infra-${host.name}-${pick.name}`) : null;
  };
  const internalNames = new Set([
    ...hosts.flatMap((h) => h.name.split(" ")),
    ...hosts.flatMap((h) => h.services.map((s) => s.name)),
  ].map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
  for (const host of hosts) {
    for (const service of host.services) {
      if (service.dockerfile) continue; // built from this repo's modules
      infraMembers.push({
        id: kebab(`infra-${host.name}-${service.name}`), label: titleCase(service.name),
        archetype: service.imageClass ?? "cloud", kind: "infra",
        description: `${service.image ?? "container"} on the ${host.name} host.`,
        path: host.file,
      });
    }
    const hostDir = dirname(host.file);
    const hostQualifiers = host.name.split(" ").filter(Boolean);
    for (const config of allFiles.filter((f) => dirname(f) === hostDir && /\.ya?ml$/.test(f) && !/docker-compose/.test(basename(f))
      && hostQualifiers.some((token) => basename(f).includes(token)))) {
      const rawLines = readText(join(repo, config)).split("\n");
      rawLines.forEach((line, index) => {
        const envToken = /endpoint:.*\$\{env:([A-Z0-9_]+)\}/.exec(line)?.[1];
        if (!envToken) return;
        const windowText = rawLines.slice(Math.max(0, index - 4), index + 5).join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
        if ([...internalNames].some((name) => name.length >= 4 && windowText.includes(name))) return;
        const candidate = envToken.split("_")
          .filter((word) => !["OTLP", "HTTP", "GRPC", "ENDPOINT", "URL", "ADDR", "HOST", "PROD", "UAT", "DEV", "TEST", "STAGING"].includes(word))
          .join(" ").toLowerCase();
        if (candidate.length < 4) return;
        infraMembers.push({
          id: kebab(`external-${candidate}`), label: titleCase(candidate),
          archetype: "cloud", kind: "external",
          description: `External receiver declared in ${config}.`, path: config,
        });
        const exporterId = infraCollectorFor(host);
        if (exporterId) {
          addOverviewEdge({ id: `${exporterId}--${kebab(`external-${candidate}`)}`, from: exporterId, to: kebab(`external-${candidate}`),
            kind: "data_flow", evidence: "declared", label: "OTLP export", sourceRefs: [{ path: config }] });
        }
      });
      // Config-declared forwarding: another host's name or service name in
      // this config's exporter lines links the collectors / target module.
      const exportLines = rawLines.filter((l) => /endpoint:|\$\{env:/.test(l)).map((l) => l.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const hostTokens = host.name.split(" ").filter(Boolean);
      const from = infraCollectorFor(host);
      if (!from) continue;
      for (const other of hosts) {
        if (other === host) continue;
        const distinct = other.name.split(" ").filter((t) => t && !hostTokens.includes(t)).map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""));
        if (distinct.length && exportLines.some((l) => distinct.some((t) => l.includes(t)))) {
          const to = infraCollectorFor(other);
          if (to) addOverviewEdge({ id: `${from}--${to}`, from, to, kind: "data_flow", evidence: "declared", label: "OTLP forward", sourceRefs: [{ path: config }] });
        }
        for (const service of other.services) {
          const normalised = service.name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (normalised.length < 6 || !exportLines.some((l) => l.includes(normalised))) continue;
          const targetModule = service.entryFile ? fileToModule.get(service.entryFile) : null;
          if (targetModule) addOverviewEdge({ id: `${from}--${targetModule}`, from, to: targetModule, kind: "data_flow", evidence: "declared", label: "OTLP forward", sourceRefs: [{ path: config }] });
        }
      }
    }
  }
  // Backing stores that only exist in deduped compose variants (the dev
  // compose's postgres container) still represent real infrastructure.
  for (const candidate of candidateHosts) {
    for (const service of candidate.services) {
      if (["database", "queue", "storage"].includes(service.imageClass) && !service.dockerfile) {
        infraMembers.push({
          id: kebab(`infra-${service.name}`), label: titleCase(service.name),
          archetype: service.imageClass, kind: "infra",
          description: `${service.image ?? "container"} declared in ${candidate.file}.`,
          path: candidate.file,
        });
      }
    }
  }
  if (edgeHost) infraMembers.push({ id: "infra-cloudflare-worker", label: "Cloudflare Worker", archetype: "worker", kind: "infra", description: `Declared in ${edgeHost.file}.`, path: edgeHost.file });
  if (drizzleConfig) infraMembers.push({ id: "infra-drizzle-database", label: "Database", archetype: "database", kind: "infra", description: `Declared in ${drizzleConfig}.`, path: drizzleConfig });
  const seenInfra = new Set();
  const uniqueInfra = infraMembers.filter((m) => !seenInfra.has(m.id) && seenInfra.add(m.id));
  if (uniqueInfra.length) {
    overviewNodes.push({
      id: "infrastructure-district", label: "Infrastructure & external", kind: "scope", archetype: "district",
      description: `Deployed infrastructure and external systems — ${uniqueInfra.length} node${uniqueInfra.length === 1 ? "" : "s"}.`,
      display: { color: OVERVIEW_INFRA_COLOR },
    });
    for (const m of uniqueInfra) {
      overviewNodes.push({
        id: m.id, label: m.label, kind: m.kind, archetype: m.archetype,
        parentId: "infrastructure-district",
        description: m.description, sourceRefs: [{ path: m.path }],
        display: { color: OVERVIEW_INFRA_COLOR },
      });
    }
  }

  // Remaining data-flow edges: OTLP producers into the gateway collector, and
  // database reads/writes.
  const otlpTarget = uniqueInfra.find((m) => /collector/.test(m.id) && /gateway/.test(m.id))
    ?? uniqueInfra.find((m) => /collector/.test(m.id));
  const databaseTarget = uniqueInfra.find((m) => m.archetype === "database");
  for (const m of allModules) {
    const texts = m.files.map((f) => readText(join(repo, f)));
    if (otlpTarget && texts.some((t) => OTLP_PATTERN.test(t))) {
      addOverviewEdge({ id: `${m.id}--${otlpTarget.id}`, from: m.id, to: otlpTarget.id,
        kind: "data_flow", evidence: "inferred", confidence: 0.7, label: "OTLP export" });
    }
    if (databaseTarget && m.id !== databaseTarget.id) {
      if (texts.some((t) => DB_WRITE_PATTERN.test(t))) {
        addOverviewEdge({ id: `${m.id}--${databaseTarget.id}-w`, from: m.id, to: databaseTarget.id,
          kind: "data_flow", evidence: "inferred", confidence: 0.75, label: "writes" });
      }
      if (texts.some((t) => DB_READ_PATTERN.test(t))) {
        addOverviewEdge({ id: `${databaseTarget.id}--${m.id}-r`, from: databaseTarget.id, to: m.id,
          kind: "data_flow", evidence: "inferred", confidence: 0.75, label: "reads" });
      }
    }
  }
  const emittedOverviewIds = new Set(overviewNodes.map((n) => n.id));
  const finalOverviewEdges = overviewEdges.filter((e) => emittedOverviewIds.has(e.from) && emittedOverviewIds.has(e.to));

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
      "Overview mode: dev-tooling/orphan exclusion is intentionally skipped.",
      "Only data-flow edges are shown; import dependencies are omitted by design.",
      "Shared-code districts (>=60% high fan-in / low fan-out modules) are coloured differently.",
      "Complexity is a decision-point count (if/for/while/case/catch/&&/||/??), not exact cyclomatic complexity.",
    ],
  };
  const overviewMermaidId = (id) => id.replace(/[^a-zA-Z0-9_]/g, "_");
  const overviewMermaid = [
    `# ${overviewMap.name}`,
    "",
    "```mermaid",
    "flowchart TB",
    ...overviewNodes.filter((n) => n.kind === "scope").flatMap((scope) => [
      `  subgraph ${overviewMermaidId(scope.id)}["${scope.label}${scope.description.startsWith("Shared") ? " (shared code)" : ""}"]`,
      ...overviewNodes.filter((n) => n.parentId === scope.id)
        .map((n) => `    ${overviewMermaidId(n.id)}["${n.label}<br/><i>${n.metrics ? `${n.metrics.loc} loc, cx ${n.metrics.complexity}` : n.archetype}</i><br/>${(n.sourceRefs?.[0]?.path ?? "").replace(/"/g, "'")}"]`),
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
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
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
const QA_SCRIPT_PATTERN = /^(check|lint|test|typecheck|coverage|knip|audit|format|fmt|quality|adr|rfc|docs?|prepare|prepack|postinstall|release|clean|proof|prove|uat|spike|poc|bench(mark)?)([:._-]|$)/i;

const deployRoots = new Set();
const scriptRoots = new Set();
const operationalRoots = new Set();

for (const host of hosts) {
  for (const service of host.services) {
    if (service.entryFile) deployRoots.add(service.entryFile);
    for (const copy of service.copies) {
      for (const f of sourceFiles) if (f.startsWith(copy.replace(/\/$/, "") + "/")) deployRoots.add(f);
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
      for (const f of sourceFiles) if (f.startsWith(prefix + "/")) deployRoots.add(f);
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
  room.loc = room.files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
  devToolingWarnings.push(room.files.length
    ? `Dev tooling stripped from ${room.segment}: ${excluded.length} QA-script file${excluded.length === 1 ? "" : "s"} (kept ${room.files.length} operational).`
    : `Dev tooling excluded (reachable only from QA package.json scripts): ${room.segment} (${excluded.length} files).`);
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
  for (const match of text.matchAll(/["']((?:\.\.\/)+[^"'\n]+)["']/g)) {
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

// 7a. Host districts from deployment shape.
for (const host of hosts) {
  nodes.push({
    id: host.id, label: `${titleCase(host.name)} host`, kind: "scope", archetype: "district",
    description: `Deployment host projected from ${host.file}.`,
  });
  for (const service of host.services) {
    const serviceId = kebab(`${host.id}-${service.name}`);
    const allCopiedSegments = service.copies
      .map((copy) => copy.replace(/\/$/, ""))
      .filter((copy) => copy.includes("/") || rooms.has(`${owningPackage(copy)?.id}-${kebab(copy)}`));
    // Coupling filter: drop shared lib-like dirs (high fan-in, low fan-out).
    const roomIdForCopy = (copy) => {
      const sample = sourceFiles.find((f) => f.startsWith(copy + "/"));
      return sample ? fileToRoom.get(sample)?.id : null;
    };
    const copiedSegments = allCopiedSegments.filter((copy) => {
      const roomId = roomIdForCopy(copy);
      return !(roomId && isUtilityRoom(roomId));
    });
    for (const copy of allCopiedSegments) { claimedSegments.add(copy); serviceClaimedDirs.add(copy); }
    const serviceSourceFiles = [];
    for (const copy of copiedSegments) {
      for (const f of sourceFiles) if (f.startsWith(copy + "/")) { fileNodeOwner.set(f, serviceId); serviceSourceFiles.push(f); }
    }
    campusFileSets.push({ id: serviceId, files: serviceSourceFiles });
    const isScheduled = Boolean(service.schedule);
    const roomsForService = copiedSegments.length >= 2;
    const archetype = roomsForService
      ? "building"
      : service.imageClass ?? (isScheduled ? "worker" : service.hasPorts ? "gateway" : "worker");
    const flowLayer = service.imageClass === "database" || service.imageClass === "queue"
      || service.imageClass === "storage" ? 2 : service.hasPorts && !service.dockerfile ? 0
      : isScheduled ? 1 : service.dockerfile ? 1 : 1;
    nodes.push({
      id: serviceId,
      label: titleCase(service.name),
      kind: service.dockerfile ? "deployable" : "infra",
      archetype,
      parentId: host.id,
      description: [
        service.dockerfile ? `Service built from ${service.dockerfile}.` : `Container image ${service.image ?? "unknown"}.`,
        service.schedule ? `Scheduled job (${service.schedule}).` : null,
        service.entryFile ? `Entry point ${service.entryFile}.` : null,
      ].filter(Boolean).join(" "),
      sourceRefs: [{ path: service.dockerfile ?? host.file }],
      tags: [
        isScheduled ? "cron" : null,
        service.hasPorts ? "listens" : null,
      ].filter(Boolean),
      display: { flowLayer },
    });
    // Rooms: one per source directory the image copies in.
    if (roomsForService) {
      const roomIds = [];
      const localEdges = new Map();
      for (const copy of copiedSegments) {
        const roomId = kebab(`${serviceId}-${copy}`);
        roomIds.push(roomId);
        const loc = sourceFiles.filter((f) => f.startsWith(copy + "/")).length;
        nodes.push({
          id: roomId, label: titleCase(basename(copy)), kind: "module", archetype: "room",
          parentId: serviceId,
          description: `Source copied from ${copy}/ into the ${service.name} image.`,
          sourceRefs: [{ path: copy }],
          metrics: { loc },
        });
      }
      // Local flow: entry dir first, then longest path over dir-level imports.
      for (const { from, to } of fileEdges) {
        const a = copiedSegments.find((c) => from.startsWith(c + "/"));
        const b = copiedSegments.find((c) => to.startsWith(c + "/"));
        if (a && b && a !== b) localEdges.set(`${kebab(`${serviceId}-${a}`)}->${kebab(`${serviceId}-${b}`)}`, true);
      }
      const entryDir = service.entryFile
        ? copiedSegments.find((c) => service.entryFile.startsWith(c + "/"))
        : null;
      const layers = layerByLongestPath(
        roomIds, localEdges, entryDir ? [kebab(`${serviceId}-${entryDir}`)] : []);
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
          id: toId, label: titleCase(dep), kind: "infra", archetype: variant.imageClass,
          parentId: host.id,
          description: `Backing service (image ${variant.image}) declared in a compose variant; the deployed host provides it via configuration.`,
          sourceRefs: [{ path: host.file }],
          display: { flowLayer: 2 },
        });
      }
      addEdge({ id: `${fromId}--${toId}`, from: fromId, to: toId,
        kind: "depends_on", evidence: "declared", label: "compose depends_on" });
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
  const ownConfigs = allFiles.filter((f) =>
    dirname(f) === hostDir && /\.ya?ml$/.test(f) && !/docker-compose/.test(basename(f))
    && hostTokens.some((token) => basename(f).includes(token)));
  for (const config of ownConfigs) {
    // Exporter-ish lines only: endpoints and env-var references.
    const exportLines = readText(join(repo, config)).split("\n")
      .filter((line) => /endpoint:|\$\{env:/.test(line))
      .map((line) => line.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const from = primaryServiceId(host);
    if (!from || !nodes.some((n) => n.id === from)) continue;
    for (const other of hosts) {
      if (other === host) continue;
      // Host-name match (the gateway's STACK_OTLP_ENDPOINT names the stack).
      const distinct = other.name.split(" ")
        .filter((token) => token && !hostTokens.includes(token))
        .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""));
      if (distinct.length && exportLines.some((line) => distinct.some((token) => line.includes(token)))) {
        const to = primaryServiceId(other);
        if (to && nodes.some((n) => n.id === to)) {
          addEdge({ id: `${from}--${to}`, from, to, kind: "data_flow", evidence: "declared",
            label: "OTLP forward", sourceRefs: [{ path: config }] });
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
          addEdge({ id: `${from}--${to}`, from, to, kind: "data_flow", evidence: "declared",
            label: "OTLP forward", sourceRefs: [{ path: config }] });
        }
      }
    }
    // Exporter endpoints whose env token names nothing internal are external
    // systems: LANGFUSE_OTLP_ENDPOINT -> a Langfuse external node.
    const internalNames = new Set([
      ...hosts.flatMap((h) => h.name.split(" ")),
      ...hosts.flatMap((h) => h.services.map((s) => s.name)),
    ].map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
    const rawLines = readText(join(repo, config)).split("\n");
    rawLines.forEach((line, index) => {
      const envToken = /endpoint:.*\$\{env:([A-Z0-9_]+)\}/.exec(line)?.[1];
      if (!envToken) return;
      // Skip when the surrounding exporter block names something internal
      // (the span store exporter carries a SPAN_INGEST bearer header).
      const windowText = rawLines.slice(Math.max(0, index - 4), index + 5).join(" ")
        .toLowerCase().replace(/[^a-z0-9]/g, "");
      if ([...internalNames].some((name) => name.length >= 4 && windowText.includes(name))) return;
      const candidate = envToken.split("_")
        .filter((word) => !["OTLP", "HTTP", "GRPC", "ENDPOINT", "URL", "ADDR", "HOST", "PROD", "UAT", "DEV", "TEST", "STAGING"].includes(word))
        .join(" ").toLowerCase();
      if (candidate.length < 4) return;
      const externalId = kebab(candidate);
      if (!nodes.some((n) => n.id === externalId)) {
        nodes.push({
          id: externalId, label: titleCase(candidate), kind: "external", archetype: "cloud",
          parentId: host.id,
          description: `External receiver declared by the ${host.name} host's exporter configuration (${envToken}).`,
          sourceRefs: [{ path: config }],
          display: { flowLayer: 4 },
        });
      }
      addEdge({ id: `${from}--${externalId}`, from, to: externalId,
        kind: "data_flow", evidence: "declared", label: "OTLP export", sourceRefs: [{ path: config }] });
    });
  }
}

// 7b. Cloudflare edge district.
if (edgeHost) {
  const districtId = "edge-delivery";
  nodes.push({
    id: districtId, label: "Cloudflare edge", kind: "scope", archetype: "district",
    description: `Edge deployment declared in ${edgeHost.file}.`,
  });
  nodes.push({
    id: "edge-worker", label: titleCase(edgeHost.name), kind: "deployable", archetype: "worker",
    parentId: districtId,
    description: `Cloudflare Worker${edgeHost.main ? ` with entry point ${edgeHost.main}` : ""}.`,
    sourceRefs: [{ path: edgeHost.main ?? edgeHost.file }],
    display: { flowLayer: 0 },
  });
  if (edgeHost.main) claimedSegments.add(edgeHost.main.split("/")[0]);
  for (const binding of edgeHost.d1) {
    const id = kebab(`d1-${binding.database_name ?? binding.binding}`);
    nodes.push({
      id, label: binding.database_name ?? binding.binding, kind: "infra", archetype: "database",
      parentId: districtId, sourceRefs: [{ path: edgeHost.file }], display: { flowLayer: 1 },
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
  const prefix = room.segment === "(root)"
    ? null
    : room.pkg.dir === "." ? room.segment : join(room.pkg.dir, room.segment);
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
    // Orphans: imported by nothing, reachable from nothing, no OTLP coupling,
    // not an entry dir, not referenced by path from another package. Sample
    // and demo material (examples/) falls out here.
    if (!pathReassignments.has(room.id)
      && (roomCoupling.get(room.id)?.in ?? 0) === 0
      && !ENTRY_DIR_NAMES.has(basename(room.segment))
      && room.files.every((f) => !deployReachable.has(f) && !scriptReachable.has(f))
      && !room.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f))))) {
      warnings.push(`Orphan area excluded (unreferenced, undeployed): ${room.segment} (${room.files.length} files).`);
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
  const layers = layerByLongestPath(pkgRooms.map((r) => r.id), roomEdges, entries);

  // A district never wraps a single synthetic building: rooms are promoted to
  // campus structures directly. Non-residual packages keep a package district
  // as the grouping; residual leftovers get a district per structured dir
  // (devstack, bootstrap) and district-less nodes for flat dirs.
  if (!residual && !nodes.some((n) => n.id === scopeId)) {
    nodes.push({
      id: scopeId, label: titleCase(pkg.name), kind: "scope", archetype: "district",
      description: `Package ${pkg.name}, rooted at ${pkg.dir === "." ? "the repository root" : pkg.dir + "/"}.`,
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
          id: parentId, label: titleCase(reassigned.pkg.name), kind: "scope", archetype: "district",
          description: `Package ${reassigned.pkg.name}, rooted at ${reassigned.pkg.dir === "." ? "the repository root" : reassigned.pkg.dir + "/"}.`,
        });
      }
      const fromRoom = fileToRoom.get(reassigned.fromFile);
      if (fromRoom) {
        addEdge({ id: `${fromRoom.id}--${room.id}`, from: fromRoom.id, to: room.id,
          kind: "depends_on", evidence: "declared", label: "path reference",
          sourceRefs: [{ path: reassigned.fromFile }] });
      }
    } else if (!residual) {
      parentId = scopeId;
    } else if (expandable) {
      // A residual structured dir never wraps a single building either: the
      // district holds the dir's parts directly as campus structures.
      const districtId = `${room.id}-district`;
      nodes.push({
        id: districtId, label, kind: "scope", archetype: "district",
        description: `Standalone area: ${room.segment}/.`,
      });
      for (const child of children) {
        const childId = kebab(`${room.id}-${child.seg}`);
        const childLoc = child.files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
        const childAsBuilding = modulesAsBuildings && child.files.length >= 2;
        nodes.push({
          id: childId,
          label: child.seg === "(files)" ? "Support files" : titleCase(child.seg),
          kind: "module", archetype: childAsBuilding ? "building" : "worker",
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
      kind: "module", archetype: expandable || leafAsBuilding ? "building" : isEntry ? "gateway" : "worker",
      ...(parentId ? { parentId } : {}),
      description: `${room.files.length} source file${room.files.length === 1 ? "" : "s"} under ${room.segment === "(root)" ? "the package root" : room.segment + "/"}.`,
      sourceRefs: room.segment === "(root)"
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
        nodes.push({
          id: kebab(`${room.id}-${child.seg}`),
          label: child.seg === "(files)" ? "Top-level files" : titleCase(child.seg),
          kind: "module", archetype: "room",
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
  const entryRoom = [...rooms.values()].find((r) =>
    r.pkg === ownerPkg && ENTRY_DIR_NAMES.has(basename(r.segment)) && nodes.some((n) => n.id === r.id));
  if (entryRoom) {
    addEdge({ id: `${entryRoom.id}--edge-worker`, from: entryRoom.id, to: "edge-worker",
      kind: "deploys", evidence: "declared", label: "wrangler deploy",
      sourceRefs: [{ path: edgeHost.file }] });
  }
}

// 7c-ii. OTLP producers: residual nodes whose source configures OpenTelemetry
// export get a data_flow edge into the OTLP-receiving collector, pulling data
// generators and agent plugins toward the ingress host they feed.
const collectorTarget =
  nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id) && /gateway/.test(n.id))
  ?? nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id));
if (collectorTarget) {
  for (const promoted of promotedNodes) {
    const emitsOtlp = promoted.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f))));
    if (!emitsOtlp) continue;
    addEdge({ id: `${promoted.id}--${collectorTarget.id}`, from: promoted.id, to: collectorTarget.id,
      kind: "data_flow", evidence: "inferred", confidence: 0.7, label: "OTLP export" });
  }
}

// 7c-iii. Shared libraries: each district keeps its own copy. This is the
// deployment truth (every service image bakes in the shared modules it
// imports) and keeps the edges short. Importers without a district share one
// floating copy in the implicit System neighbourhood.
const scopeIdSet = new Set(nodes.filter((n) => n.kind === "scope").map((n) => n.id));
const districtOfNode = new Map(nodes
  .filter((n) => n.parentId && scopeIdSet.has(n.parentId))
  .map((n) => [n.id, n.parentId]));
const packagesWithEliminations = [...new Set(
  eliminatedRooms.map((r) => rooms.get(r.id).pkg))];
for (const pkg of packagesWithEliminations) {
  const pkgEliminated = eliminatedRooms.filter((r) => rooms.get(r.id).pkg === pkg);
  const totalLoc = pkgEliminated.reduce((sum, r) => sum + rooms.get(r.id).loc, 0);
  const modules = pkgEliminated.map((r) => r.segment).join(", ");
  // Importer counts, grouped by the importer's district.
  const importsByDistrict = new Map(); // districtId|"" -> Map(owner -> count)
  for (const { from, to } of fileEdges) {
    const targetRoom = fileToRoom.get(to);
    if (!targetRoom || targetRoom.pkg !== pkg || !eliminatedRoomIds.has(targetRoom.id)) continue;
    const owner = fileNodeOwner.get(from);
    if (!owner || !nodes.some((n) => n.id === owner)) continue;
    const district = districtOfNode.get(owner) ?? "";
    if (!importsByDistrict.has(district)) importsByDistrict.set(district, new Map());
    const counts = importsByDistrict.get(district);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  for (const [district, counts] of importsByDistrict) {
    const copyId = kebab(`${district || pkg.id}-shared-libraries`);
    const copyAsBuilding = modulesAsBuildings && pkgEliminated.length >= 2;
    if (!nodes.some((n) => n.id === copyId)) {
      nodes.push({
        id: copyId, label: "Shared libraries", kind: "module",
        archetype: copyAsBuilding ? "building" : "storage",
        ...(district ? { parentId: district } : {}),
        description: `This district's copy of the shared utility modules (high fan-in, low fan-out): ${modules}.`,
        sourceRefs: pkgEliminated.map((r) => ({ path: roomDir(rooms.get(r.id)) })),
        metrics: { loc: totalLoc },
        display: { flowLayer: 3 },
      });
      if (copyAsBuilding) {
        for (const r of pkgEliminated) {
          const moduleRoom = rooms.get(r.id);
          nodes.push({
            id: kebab(`${copyId}-${r.segment}`),
            label: titleCase(r.segment.split(sep).join(" / ")),
            kind: "module", archetype: "room", parentId: copyId,
            description: `Fan-in ${r.in}, fan-out ${r.out}, instability ${r.instability.toFixed(2)}.`,
            sourceRefs: [{ path: roomDir(moduleRoom) }],
          });
        }
      }
    }
    for (const [owner, count] of counts) {
      if (owner === copyId) continue;
      addEdge({ id: `${owner}--${copyId}`, from: owner, to: copyId,
        kind: "depends_on", evidence: "declared",
        label: `${count} import${count === 1 ? "" : "s"}` });
    }
  }
}

// 7d. Room-level and package-level import edges (only between nodes that exist).
const nodeIds = new Set(nodes.map((n) => n.id));
for (const [key, count] of roomEdges) {
  const [from, to] = key.split("->");
  if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
  addEdge({ id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared",
    label: `${count} import${count === 1 ? "" : "s"}` });
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
  addEdge({ id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared",
    label: `${count} import${count === 1 ? "" : "s"}` });
}

// 7e. Drizzle database when no D1 binding declared it already.
if (drizzleConfig && ![...nodeIds].some((id) => id.startsWith("d1-"))) {
  const dialect = /dialect:\s*["'](\w+)["']/.exec(readText(join(repo, drizzleConfig)))?.[1];
  const owner = owningPackage(drizzleConfig);
  const parent = edgeHost ? "edge-delivery" : owner ? `${owner.id}-area` : undefined;
  if (parent && nodeIds.has(parent)) {
    nodes.push({
      id: "drizzle-database", label: `Database (${dialect ?? "sql"})`, kind: "infra",
      archetype: "database", parentId: parent,
      description: `Drizzle ORM schema declared in ${drizzleConfig}.`,
      sourceRefs: [{ path: drizzleConfig }], display: { flowLayer: 1 },
    });
    const from = edgeHost ? "edge-worker" : owner?.id;
    if (from && nodeIds.has(from) || nodes.some((n) => n.id === from)) {
      addEdge({ id: `${from}--drizzle-database`, from, to: "drizzle-database", kind: "depends_on", evidence: "declared" });
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

const classificationSets = [
  ...campusFileSets,
  ...promotedNodes.map(({ id, files }) => ({ id, files })),
];
const districtLookup = new Map(nodes
  .filter((n) => n.parentId && nodes.some((s) => s.id === n.parentId && s.kind === "scope"))
  .map((n) => [n.id, n.parentId]));
const databaseNodes = nodes.filter((n) => n.archetype === "database");

for (const { id, files } of classificationSets) {
  const node = nodes.find((n) => n.id === id);
  if (!node || !files.length) continue;
  let listens = false, callsOut = false, writes = false, reads = false;
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
  const database = databaseNodes.find((db) => districtLookup.get(db.id) === districtLookup.get(id))
    ?? databaseNodes[0];
  if (!database || database.id === id) continue;
  if (writes) {
    addEdge({ id: `${id}--${database.id}-w`, from: id, to: database.id,
      kind: "data_flow", evidence: "inferred", confidence: 0.75, label: "writes" });
  }
  if (reads) {
    addEdge({ id: `${database.id}--${id}-r`, from: database.id, to: id,
      kind: "data_flow", evidence: "inferred", confidence: 0.75, label: "reads" });
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
    file: h.file, name: h.name,
    services: h.services.map(({ name, image, dockerfile, entryFile, copies, schedule, hasPorts, imageClass }) =>
      ({ name, image, dockerfile, entryFile, copies, schedule, hasPorts, imageClass })),
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
  "  rankdir=LR; node [shape=box, fontname=\"Helvetica\"];",
  ...[...rooms.values()].filter((r) => r.files.length)
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
const isCampus = (n) => n.kind !== "scope" && (!n.parentId || nodes.some((s) => s.id === n.parentId && s.kind === "scope"));
const campusIds = new Set(nodes.filter(isCampus).map((n) => n.id));
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
  ...nodes.filter((n) => n.kind === "scope").flatMap((scope) => [
    `  subgraph ${mermaidId(scope.id)}["${mermaidLabel(scope.label)}"]`,
    ...nodes.filter((n) => n.parentId === scope.id).flatMap((n) => campusNodeLines(n, "    ")),
    "  end",
  ]),
  ...nodes.filter((n) => isCampus(n) && !n.parentId).flatMap((n) => campusNodeLines(n, "  ", ", no district")),
  ...finalEdges.filter((e) => renderedIds.has(e.from) && renderedIds.has(e.to))
    .map((e) => {
      const label = mermaidLabel(e.label ?? e.kind);
      const arrow = e.kind === "data_flow" ? `-. "${label}" .->` : e.kind === "deploys" ? `== "${label}" ==>` : `-- "${label}" -->`;
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
        const roomPath = r.segment === "(root)"
          ? pkgPath
          : `${pkg.dir === "." ? "" : pkg.dir + "/"}${r.segment}/`;
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
    .sort((a, b) => (b.in + b.out) - (a.in + a.out)),
  files: [...fileCoupling.entries()]
    .map(([file, c]) => ({ file, ...c, instability: Number(c.instability.toFixed(2)) }))
    .sort((a, b) => (b.in + b.out) - (a.in + a.out))
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

console.log(`Wrote ${outDir}/{map,deploy-shape,deps-files,deps-rooms,coupling}.json + deps-rooms.dot + {map,deps-rooms}.md`);
console.log(`nodes=${nodes.length} edges=${edges.length} hosts=${hosts.length} scheduled=${schedules.size} eliminated=${eliminatedRooms.length}`);
