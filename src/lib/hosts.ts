// Deployment hosts from compose files: one host district per compose file,
// with named, Dockerfile-bound, image-classified services (HEURISTICS.md
// rules D1/D2/D3/D5/D6).

import { basename, dirname, join, sep } from "node:path";
import { type ComposeService, parseComposeServices } from "./compose.ts";
import type { CrontabSchedule } from "./crontab.ts";
import { parseDockerfile } from "./dockerfile.ts";
import { readText } from "./read.ts";
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
function isCanonicalComposeFile(file: string): boolean {
    return /^(docker-)?compose\.ya?ml$/.test(basename(file));
}

/**
 * The ownership key for a service in a compose directory: services fold across
 * topology files within the same directory, so the key pairs the directory
 * with the service name.
 *
 * @param file - Repo-relative path of the compose file.
 * @param serviceName - The compose service name.
 * @returns The `<dir> <name>` key used by {@link HostShape.serviceOwner}.
 */
function serviceOwnerKey(file: string, serviceName: string): string {
    return `${dirname(file)} ${serviceName}`;
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
 * being redrawn here. Shared by both map assemblers.
 *
 * @param serviceOwner - The {@link HostShape.serviceOwner} map.
 * @param host - The host the service would be drawn under.
 * @param serviceName - The compose service name.
 * @returns True when another host owns this service name in the directory.
 */
export function isServiceShadowed(
    serviceOwner: ReadonlyMap<string, string>,
    host: Pick<Host, "file" | "id">,
    serviceName: string,
): boolean {
    const owner = serviceOwner.get(serviceOwnerKey(host.file, serviceName));
    return owner !== undefined && owner !== host.id;
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

/**
 * Builds deployment hosts: one per compose file (partial overlays excluded),
 * named from informative path segments, each service bound to its Dockerfile
 * (explicit build.dockerfile, resolved relative to the compose dir when
 * needed, or the images/<name>.Dockerfile convention) and classified by image
 * or name. Environment variants are deduped — a host covered >=50% by a
 * higher-ranked variant (prod > uat > example > unqualified > dev), or by
 * an equally-ranked variant with the lower filename, is
 * dropped — while service-level depends_on is harvested across ALL variants
 * so wiring declared only in a deduped variant still informs edges.
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
    const candidateHosts: Host[] = composeFiles
        .filter((file) => !/\.(override|build)\.ya?ml$/.test(basename(file)))
        .map((file) => {
            const dir = dirname(file);
            const parts = hostNameParts(file).filter((p) => p !== "example");
            // D2: an informative path segment names the host; a root or
            // all-generic compose path yields none, so fall back to the repo
            // name rather than the placeholder "host".
            const name = parts.join(" ") || basename(repo);
            const services = parseComposeServices(readText(join(repo, file))).map((service): HostService => {
                let dockerfile = service.dockerfile;
                if (dockerfile !== undefined && !fileExists(dockerfile)) {
                    const relToCompose = join(dir, dockerfile);
                    dockerfile = fileExists(relToCompose) ? relToCompose : dockerfile;
                }
                if (dockerfile === undefined) {
                    dockerfile = allFiles.find((f) => basename(f) === `${service.name}.Dockerfile`);
                }
                const built =
                    dockerfile !== undefined && fileExists(dockerfile)
                        ? parseDockerfile(repo, dockerfile, allFiles)
                        : null;
                const imageClass = classifyService(service.image, service.name);
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

    const serviceNames = (host: Host) => new Set(host.services.map((s) => s.name));
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

    // D1: within a compose directory, a service name recurring across the
    // surviving hosts folds to a single owner — the canonical (unqualified)
    // file if one defines it, else the highest env rank, else the lowest
    // filename. Iterating the stable `hosts` array keeps the pick deterministic.
    const claims = new Map<string, ServiceClaim>();
    for (const host of hosts) {
        const canonical = isCanonicalComposeFile(host.file);
        for (const service of host.services) {
            const key = serviceOwnerKey(host.file, service.name);
            const candidate: ServiceClaim = { hostId: host.id, canonical, rank: host.rank, file: host.file };
            if (claimBeats(candidate, claims.get(key))) claims.set(key, candidate);
        }
    }
    const serviceOwner = new Map<string, string>();
    for (const [key, claim] of claims) serviceOwner.set(key, claim.hostId);

    return { hosts, candidateHosts, serviceDependsOn, serviceOwner };
}
