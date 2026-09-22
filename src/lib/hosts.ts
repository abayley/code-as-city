// Deployment hosts from compose files: one host district per compose file,
// with named, Dockerfile-bound, image-classified services (HEURISTICS.md
// rules D1/D2/D3/D5/D6).

import { basename, dirname, join, sep } from "node:path";
import { uniqueId } from "./assembly-helpers.ts";
import { type ComposeService, parseComposeServices } from "./compose.ts";
import type { CrontabSchedule } from "./crontab.ts";
import { parseDockerfile } from "./dockerfile.ts";
import { isTestPath } from "./inventory.ts";
import { parseDotEnv, readJsonSafe, readText } from "./read.ts";
import { kebab } from "./text.ts";

// Known container images -> infra classification. Databases are matched
// precisely by exact base image name (see DATABASE_IMAGES / imageBaseName): a
// substring match reads postgrest/postgrest and supabase/postgres-meta as
// databases, which they are not (D5, HC-010). The remaining categories are
// vendor families where a substring is the right signal.
const IMAGE_CLASSES = [
    { pattern: /redis|valkey|rabbitmq|kafka|nats/, archetype: "queue" },
    { pattern: /minio|s3/, archetype: "storage" },
    { pattern: /nginx|traefik|caddy|haproxy|envoy/, archetype: "gateway" },
    { pattern: /langfuse|latitude|grafana|prometheus|otel|collector/, archetype: "cloud" },
] as const;

// Exact base image names classed as databases. Deliberately exact so a shared
// prefix (postgrest, postgres-meta) is not mistaken for the store, while real
// server variants (clickhouse-server, mongo) are still recognised (D5).
const DATABASE_IMAGES = new Set([
    "postgres",
    "postgresql",
    "mysql",
    "mariadb",
    "sqlite",
    "clickhouse",
    "clickhouse-server",
    "mongo",
    "mongodb",
    "cockroachdb",
]);

/**
 * The base name of a container image reference: the final path segment with
 * any tag or digest stripped. `supabase/postgres:15.1.0` -> `postgres`,
 * `postgrest/postgrest:latest` -> `postgrest`.
 *
 * @param image - A docker image reference.
 * @returns The base name used for exact classification.
 */
function imageBaseName(image: string): string {
    const lastSegment = image.split("/").at(-1) ?? image;
    return lastSegment.split(/[:@]/)[0] ?? lastSegment;
}

/**
 * D5 infra classification: a service's archetype from its image, else a
 * store-like service name. Databases require an exact base image name or a
 * store-like service name; the remaining categories match a vendor family by
 * substring. A service with neither signal is unclassified (undefined).
 *
 * @param image - The service's container image reference, if any.
 * @param name - The compose service name.
 * @returns The infra archetype, or undefined when nothing classifies it.
 */
function classifyService(image: string | undefined, name: string): string | undefined {
    if (image !== undefined) {
        if (DATABASE_IMAGES.has(imageBaseName(image))) return "database";
        const family = IMAGE_CLASSES.find(({ pattern }) => pattern.test(image))?.archetype;
        if (family !== undefined) return family;
    }
    if (/database|postgres|mysql|db$/.test(name)) return "database";
    if (/redis|queue|broker|kafka/.test(name)) return "queue";
    if (/proxy|nginx|ingress/.test(name)) return "gateway";
    return undefined;
}

export type HostService = ComposeService & {
    dockerfile?: string | undefined;
    copies: string[];
    entryFile: string | null;
    schedule?: string | undefined;
    imageClass?: string | undefined;
    /** HC-024/REVIEW-0010: a dev environment (bind-mounted checkout or dev-server command), not a deployment. */
    devEnvironment?: boolean | undefined;
};

export type Host = {
    file: string;
    name: string;
    id: string;
    services: HostService[];
    rank: number;
};

const GENERIC_SEGMENTS = new Set(["deploy", "deployment", "deployments", "docker", "compose", "infra", "products"]);
const ENV_RANK: readonly (readonly [RegExp, number])[] = [
    [/prod/, 5],
    [/uat|stag/, 4],
    [/example/, 3],
    [/dev/, 1],
];

/**
 * D2: derives the host's name parts from the compose file's path — the
 * informative directory segments (generic ones like "deploy" dropped) plus
 * any filename qualifiers (docker-compose.<qualifier>.yml).
 *
 * @param file - Repo-relative path of the compose file.
 * @returns The name parts in path order, deduplicated against the dirs.
 */
function hostNameParts(file: string): string[] {
    const qualifiers = basename(file)
        .replace(/\.ya?ml$/, "")
        .split(".")
        .filter((part) => part && part !== "docker-compose" && part !== "compose");
    const dirParts = dirname(file)
        .split(sep)
        .filter((seg) => seg !== "." && !GENERIC_SEGMENTS.has(seg));
    return [...dirParts, ...qualifiers.filter((q) => !dirParts.includes(q))];
}

/**
 * D1's environment rank for host dedup: prod 5, uat/staging 4, example 3,
 * unqualified 2, dev 1.
 *
 * @param file - Repo-relative path of the compose file.
 * @returns The rank; higher-ranked variants win dedup ties.
 */
function envRank(file: string): number {
    for (const [pattern, rank] of ENV_RANK) if (pattern.test(file)) return rank;
    return 2;
}

/**
 * Whether a compose file is a canonical, unqualified topology
 * (`docker-compose.yml`, `compose.yaml`, ...) rather than an environment- or
 * backend-qualified variant (`docker-compose.s3.yml`). D1 prefers the
 * canonical file when folding a service that recurs across topologies.
 *
 * @param file - Repo-relative path of the compose file.
 * @returns True when the filename carries no qualifier.
 */
export function isCanonicalComposeFile(file: string): boolean {
    return /^(docker-)?compose\.ya?ml$/.test(basename(file));
}

/** A service's deployment identity: its name plus the image that ships it (HC-020). */
export type ServiceIdentity = {
    name: string;
    image?: string | undefined;
};

/**
 * The ownership key for a service in a compose directory: services fold across
 * topology files within the same directory, so the key pairs the directory
 * with the service name **and its image** (HC-020) — alternative services that
 * merely share a name but ship different images are distinct, not duplicates.
 *
 * @param file - Repo-relative path of the compose file.
 * @param service - The compose service (its name and image).
 * @returns The `<dir> <name> <image>` key used by {@link HostShape.serviceOwner}.
 */
function serviceOwnerKey(file: string, service: ServiceIdentity): string {
    return `${dirname(file)} ${service.name} ${service.image ?? ""}`;
}

/** A host's claim on a service name, ranked to pick the D1 owner. */
type ServiceClaim = { hostId: string; canonical: boolean; rank: number; file: string };

/**
 * Whether a candidate claim on a service name beats the incumbent: a canonical
 * file wins over a qualified one, then a higher env rank, then the lower
 * filename. A total order, so the winner is independent of iteration order.
 *
 * @param candidate - The claim under consideration.
 * @param existing - The current best claim, or undefined when none yet.
 * @returns True when the candidate should replace the incumbent.
 */
function claimBeats(candidate: ServiceClaim, existing: ServiceClaim | undefined): boolean {
    if (existing === undefined) return true;
    if (candidate.canonical !== existing.canonical) return candidate.canonical;
    if (candidate.rank !== existing.rank) return candidate.rank > existing.rank;
    return candidate.file < existing.file;
}

/**
 * D1: whether a service is shadowed under a host — owned by a different host's
 * canonical topology file, so it folds to that owner's single node rather than
 * being redrawn here. Ownership matches on name **and image** (HC-020): a
 * same-named service shipping a different image is an alternative, not a
 * duplicate, and is not shadowed. Shared by both map assemblers.
 *
 * @param serviceOwner - The {@link HostShape.serviceOwner} map.
 * @param host - The host the service would be drawn under.
 * @param service - The compose service (its name and image).
 * @returns True when another host owns this name-and-image in the directory.
 */
export function isServiceShadowed(
    serviceOwner: ReadonlyMap<string, string>,
    host: Pick<Host, "file" | "id">,
    service: ServiceIdentity,
): boolean {
    const owner = serviceOwner.get(serviceOwnerKey(host.file, service));
    return owner !== undefined && owner !== host.id;
}

/**
 * Whether a build context is a usable repo-relative path: not absolute and
 * not scheme-prefixed (a registry or http(s) reference), so it can be joined
 * under the compose dir.
 *
 * @param context - The service's `build.context` value.
 * @returns True when the context can be resolved against the compose dir.
 */
function isLocalContext(context: string): boolean {
    return !context.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(context);
}

/**
 * D3 service-to-Dockerfile binding: resolves a compose service's Dockerfile
 * path and build context. Resolution order: repo-root-relative (the monorepo
 * convention), then compose-dir-relative, then build-context-relative — the
 * compose spec resolves a `build.dockerfile` against the `build.context`
 * (HC-017, immich's `context: ../machine-learning`); a build block naming
 * only a context defaults to that context's own `Dockerfile` (HC-017,
 * excalidraw's `context: .` root image); finally the
 * `images/<service>.Dockerfile` convention.
 *
 * @param options - `service` the parsed compose service; `dir` the compose
 *   file's repo-relative directory; `fileExists` tests the inventory;
 *   `allFiles` the full inventory for the naming convention.
 * @returns The resolved Dockerfile path and the build context dir to resolve
 *   its COPY sources against (both undefined when nothing binds).
 */
function resolveServiceDockerfile(options: {
    service: ComposeService;
    dir: string;
    fileExists: (path: string) => boolean;
    allFiles: readonly string[];
}): { dockerfile: string | undefined; contextDir: string | undefined } {
    const { service, dir, fileExists, allFiles } = options;
    let dockerfile = service.dockerfile;
    if (dockerfile !== undefined && !fileExists(dockerfile)) {
        const relToCompose = join(dir, dockerfile);
        dockerfile = fileExists(relToCompose) ? relToCompose : dockerfile;
    }
    const context = service.context;
    const contextLocal = context !== undefined && isLocalContext(context);
    let contextDir: string | undefined;
    if (dockerfile !== undefined && !fileExists(dockerfile) && contextLocal) {
        const relToContext = join(dir, context, dockerfile);
        if (fileExists(relToContext)) {
            dockerfile = relToContext;
            contextDir = join(dir, context);
        }
    }
    if (dockerfile === undefined && contextLocal) {
        const contextDefault = join(dir, context, "Dockerfile");
        if (fileExists(contextDefault)) {
            dockerfile = contextDefault;
            contextDir = join(dir, context);
        }
    }
    if (dockerfile === undefined) {
        dockerfile = allFiles.find((f) => basename(f) === `${service.name}.Dockerfile`);
    }
    return { dockerfile, contextDir };
}

export type HostShape = {
    hosts: Host[];
    candidateHosts: Host[];
    serviceDependsOn: Map<string, Set<string>>;
    /**
     * D1 cross-topology consolidation: the id of the single host that owns each
     * service name within a compose directory. A service recurring across
     * topology files in that directory folds to its owner's node; occurrences
     * in any other host are shadowed. Keyed by {@link serviceOwnerKey}.
     */
    serviceOwner: Map<string, string>;
};

type EcsContainer = {
    name?: string;
    image?: string;
    portMappings?: { containerPort?: number; hostPort?: number }[];
    dependsOn?: { containerName?: string }[];
};

type EcsTaskDef = { family?: string; containerDefinitions?: EcsContainer[] };

/**
 * D22: parses an ECS task-definition file into a host district. Each
 * container definition becomes a service — image, port mappings (kept as
 * `host:container` strings for the D19/D20 port matching), and container
 * dependencies, which join the D6 `depends_on` harvest. Files that fail to
 * parse or declare no containers are not topologies and yield nothing.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param file - Repo-relative path of the task-definition file.
 * @returns The host, or null when the file declares no containers.
 */
function parseEcsHost(repo: string, file: string): Host | null {
    const taskDef = (readJsonSafe(readText(join(repo, file))) ?? {}) as EcsTaskDef;
    const containers = (taskDef.containerDefinitions ?? []).filter((c) => c.name);
    if (!containers.length) return null;
    const name = taskDef.family?.trim() || basename(repo);
    const services = containers.map((container): HostService => {
        const ports = (container.portMappings ?? [])
            .filter((m) => m.containerPort !== undefined)
            .map((m) => (m.hostPort !== undefined ? `${m.hostPort}:${m.containerPort}` : `${m.containerPort}`));
        const dependsOn = (container.dependsOn ?? [])
            .map((d) => d.containerName)
            .filter((dep): dep is string => dep !== undefined);
        const imageClass = classifyService(container.image, container.name ?? "");
        return {
            name: container.name ?? "",
            image: container.image,
            ports,
            hasPorts: ports.length > 0,
            dependsOn,
            copies: [],
            entryFile: null,
            imageClass,
        };
    });
    return { file, name, id: kebab(`host-${name}`), services, rank: envRank(file) };
}

/**
 * D23: parses a directory of quadlet `.container` units into one host
 * district — a quadlet directory is one machine's deployment the way a
 * compose file is one topology's. Each unit contributes its container name
 * (the filename), image, published ports, and ordering dependencies
 * (`After`/`Requires`/`Wants` naming a sibling container, so systemd targets
 * never become dependencies).
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param dir - Repo-relative directory holding the `.container` units.
 * @param files - The directory's unit files.
 * @returns The host (always non-null: the caller only passes non-empty dirs).
 */
function parseQuadletHost(repo: string, dir: string, files: readonly string[]): Host {
    const containers = new Set(files.map((f) => basename(f).replace(/\.container$/, "")));
    const services = files.map((file): HostService => {
        const name = basename(file).replace(/\.container$/, "");
        const text = readText(join(repo, file));
        const image = /^\s*Image\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
        const ports = [...text.matchAll(/^\s*PublishPort\s*=\s*(.+?)\s*$/gm)]
            .map((m) => m[1]?.replace(/\/\w+$/, "").trim())
            .filter((p): p is string => p !== undefined && p !== "");
        const dependsOn = [...text.matchAll(/^\s*(?:After|Requires|Wants)\s*=\s*(.+?)\s*$/gm)]
            .flatMap((m) => (m[1] ?? "").split(/\s+/))
            .map((unit) => unit.replace(/\.service$/, ""))
            .filter((dep) => containers.has(dep));
        const imageClass = classifyService(image, name);
        return {
            name,
            image,
            ports,
            hasPorts: ports.length > 0,
            dependsOn,
            copies: [],
            entryFile: null,
            imageClass,
        };
    });
    const informative = dir.split(sep).filter((seg) => seg !== "." && !GENERIC_SEGMENTS.has(seg));
    const name = informative.join(" ") || basename(repo);
    return { file: dir, name, id: kebab(`host-${name}`), services, rank: envRank(dir) };
}

/**
 * Builds deployment hosts: one per compose file (partial overlays excluded),
 * named from informative path segments, each service bound to its Dockerfile
 * (explicit build.dockerfile, resolved relative to the compose dir when
 * needed, or the images/<name>.Dockerfile convention) and classified by image
 * or name. Environment variants are deduped — a host covered >=50% by a
 * higher-ranked variant (prod > uat > example > unqualified > dev), or by
 * an equally-ranked variant with the lower filename, is
 *   dropped — while service-level depends_on is harvested across ALL variants
 *   so wiring declared only in a deduped variant still informs edges. A
 *   Dockerfile no compose service builds becomes its own single-service host
 *   (HC-018: the image a user pulls and runs directly).
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param allFiles - The full repo inventory, used to resolve Dockerfile
 *   paths and validate their contents.
 * @param composeFiles - Repo-relative paths of the docker-compose files.
 * @param schedules - Crontab schedules keyed by compose service name (D4).
 * @returns The surviving hosts, every candidate variant (for cross-variant
 *   harvesting), and depends_on unions per service name.
 */
export function buildHosts(
    repo: string,
    allFiles: readonly string[],
    composeFiles: readonly string[],
    schedules: ReadonlyMap<string, CrontabSchedule>,
): HostShape {
    const fileExists = (p: string) => allFiles.includes(p);
    // I4 applies to topology files too: a compose under a test/tests dir (or a
    // *.test.* filename) is a test fixture, not the deployment shape (HC-020).
    const isTestCompose = (file: string) =>
        /(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.ya?ml$/.test(basename(file));
    const candidateHosts: Host[] = composeFiles
        .filter((file) => !/\.(override|build)\.ya?ml$/.test(basename(file)))
        .filter((file) => !isTestCompose(file))
        .map((file) => {
            const dir = dirname(file);
            const parts = hostNameParts(file).filter((p) => p !== "example");
            // D2: an informative path segment names the host; a root or
            // all-generic compose path yields none, so fall back to the repo
            // name rather than the placeholder "host".
            const name = parts.join(" ") || basename(repo);
            const services = parseComposeServices(readText(join(repo, file))).map((service): HostService => {
                const { dockerfile, contextDir } = resolveServiceDockerfile({
                    service,
                    dir,
                    fileExists,
                    allFiles,
                });
                const built =
                    dockerfile !== undefined && fileExists(dockerfile)
                        ? parseDockerfile(repo, dockerfile, allFiles, contextDir)
                        : null;
                const imageClass = classifyService(service.image, service.name);
                // HC-023: `env_file:` entries merge under explicit
                // `environment:` values (compose precedence), resolved against
                // the compose dir — the project-root approximation the
                // Dockerfile binding already uses.
                const fileEnv: Record<string, string> = {};
                for (const envPath of service.envFile ?? []) {
                    const candidate = fileExists(envPath)
                        ? envPath
                        : fileExists(join(dir, envPath))
                          ? join(dir, envPath)
                          : null;
                    if (candidate) Object.assign(fileEnv, parseDotEnv(readText(join(repo, candidate))));
                }
                return {
                    ...service,
                    environment: { ...fileEnv, ...(service.environment ?? {}) },
                    dockerfile: built ? dockerfile : undefined,
                    copies: built?.copies ?? [],
                    entryFile: built?.entryFile ?? null,
                    devEnvironment: Boolean(service.devBindMount || service.devServerCommand || built?.devServer),
                    schedule: schedules.get(service.name)?.schedule,
                    imageClass,
                };
            });
            return { file, name, id: kebab(`host-${name}`), services, rank: envRank(file) };
        });

    // D22/D23 (HC-025, second slice): platform container deployments beside
    // compose — ECS task definitions (one host per file) and quadlet unit
    // directories (one host per directory). They join the candidate hosts, so
    // the existing variant dedup, `depends_on` harvest, and name+image
    // ownership folding treat them as topologies like any other: a platform
    // file restating the compose shape folds away (an empty district is
    // dropped), while platform-only services surface under their own host.
    // Test-path files are fixtures, not topologies.
    const platformIds = new Set(candidateHosts.map((host) => host.id));
    const claimPlatformHost = (host: Host): void => {
        host.id = uniqueId(host.id, (candidate) => platformIds.has(candidate));
        platformIds.add(host.id);
        candidateHosts.push(host);
    };
    for (const file of allFiles) {
        if (!/task-definition\.json$/i.test(basename(file))) continue;
        if (isTestPath(file)) continue;
        const ecs = parseEcsHost(repo, file);
        if (ecs) claimPlatformHost(ecs);
    }
    const quadletDirs = new Map<string, string[]>();
    for (const file of allFiles) {
        if (!/\.container$/.test(file)) continue;
        if (isTestPath(file)) continue;
        const dir = dirname(file);
        quadletDirs.set(dir, [...(quadletDirs.get(dir) ?? []), file]);
    }
    for (const [dir, files] of [...quadletDirs.entries()].sort()) {
        claimPlatformHost(parseQuadletHost(repo, dir, files));
    }

    const serviceDependsOn = new Map<string, Set<string>>();
    for (const host of candidateHosts) {
        for (const service of host.services) {
            if (!service.dependsOn?.length) continue;
            let deps = serviceDependsOn.get(service.name);
            if (!deps) {
                deps = new Set();
                serviceDependsOn.set(service.name, deps);
            }
            for (const dep of service.dependsOn) deps.add(dep);
        }
    }

    // The dedup's coverage keys, parameterised by whether the image counts:
    // name-only for a dev variant (rank 1, its builds replace the canonical
    // images wholesale), name+image for a topology alternative (HC-020).
    const serviceKeys = (host: Host, withImage: boolean) =>
        new Set(host.services.map((s) => (withImage ? `${s.name} ${s.image ?? ""}` : s.name)));
    const hosts = candidateHosts.filter((host) => {
        const names = serviceKeys(host, false);
        const identities = serviceKeys(host, true);
        return !candidateHosts.some((other) => {
            if (other === host) return false;
            const otherKeys = serviceKeys(other, host.rank >= 2);
            const shared = [...(host.rank >= 2 ? identities : names)].filter((k) => otherKeys.has(k)).length;
            const covered = names.size > 0 && shared / names.size >= 0.5;
            if (!covered) return false;
            if (other.rank !== host.rank) return other.rank > host.rank;
            return other.file < host.file; // stable tie-break
        });
    });

    // D1: within a compose directory, a service name recurring across the
    // surviving hosts folds to a single owner — the canonical (unqualified)
    // file if one defines it, else the highest env rank, else the lowest
    // filename. Iterating the stable `hosts` array keeps the pick deterministic.
    const claims = new Map<string, ServiceClaim>();
    for (const host of hosts) {
        const canonical = isCanonicalComposeFile(host.file);
        for (const service of host.services) {
            const key = serviceOwnerKey(host.file, service);
            const candidate: ServiceClaim = { hostId: host.id, canonical, rank: host.rank, file: host.file };
            if (claimBeats(candidate, claims.get(key))) claims.set(key, candidate);
        }
    }
    const serviceOwner = new Map<string, string>();
    for (const [key, claim] of claims) serviceOwner.set(key, claim.hostId);

    // HC-018: a standalone Dockerfile with no compose owner declares a
    // deployment of its own (ollama-code's root image, pulled and run
    // directly): one single-service host per unowned Dockerfile. Guarded
    // twice — a Dockerfile a compose service already builds (including via a
    // context-default Dockerfile, HC-017) is not drawn again, and a Dockerfile
    // under a test path (I4) is a fixture, not a deployment. The image is
    // whatever the Dockerfile runs, so there is no D5 classification; a
    // dev/test/local filename qualifier (Dockerfile.dev) tags the service
    // dev-environment like a dev-server command does, rather than excluding
    // it. The `image` qualifier keeps a repo's Dockerfile host distinct from
    // its compose host of the same basename.
    const boundDockerfiles = new Set(
        candidateHosts.flatMap((host) => host.services.map((service) => service.dockerfile)),
    );
    const takenIds = new Set(hosts.map((host) => host.id));
    for (const file of allFiles) {
        const base = basename(file);
        if (!/^[Dd]ockerfile([-_.].+)?$/.test(base)) continue;
        // A source module named like a variant (this repo's own
        // src/lib/dockerfile.ts) is code, not a build declaration.
        if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(base)) continue;
        if (boundDockerfiles.has(file) || isTestPath(file)) continue;
        const dir = dirname(file);
        const parsed = parseDockerfile(repo, file, allFiles, dir === "." ? undefined : dir);
        const name = `${basename(repo)} image`;
        const id = uniqueId(kebab(`host-${name}`), (candidate) => takenIds.has(candidate));
        takenIds.add(id);
        // A dev/test/local filename qualifier names a non-production image
        // (Dockerfile.dev); segment-wise, so Dockerfile-latest stays a host.
        const qualifier = basename(file)
            .replace(/^[Dd]ockerfile/, "")
            .split(/[-_.]/);
        const devVariant = qualifier.some((segment) => /^(dev|test|local)$/i.test(segment));
        const standalone: Host = {
            file,
            name,
            id,
            services: [
                {
                    name: "app",
                    dockerfile: file,
                    copies: parsed.copies,
                    entryFile: parsed.entryFile,
                    devEnvironment: Boolean(parsed.devServer || devVariant),
                },
            ],
            rank: envRank(file),
        };
        candidateHosts.push(standalone);
        hosts.push(standalone);
    }

    return { hosts, candidateHosts, serviceDependsOn, serviceOwner };
}
