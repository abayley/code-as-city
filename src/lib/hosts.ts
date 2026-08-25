// Deployment hosts from compose files: one host district per compose file,
// with named, Dockerfile-bound, image-classified services (HEURISTICS.md
// rules D1/D2/D3/D5/D6).

import { basename, dirname, join, sep } from "node:path";
import { type ComposeService, parseComposeServices } from "./compose.ts";
import type { CrontabSchedule } from "./crontab.ts";
import { parseDockerfile } from "./dockerfile.ts";
import { readText } from "./read.ts";
import { kebab } from "./text.ts";

// Known container images -> infra classification.
const IMAGE_CLASSES = [
    { pattern: /postgres|mysql|mariadb|sqlite|clickhouse/, archetype: "database" },
    { pattern: /redis|valkey|rabbitmq|kafka|nats/, archetype: "queue" },
    { pattern: /minio|s3/, archetype: "storage" },
    { pattern: /nginx|traefik|caddy|haproxy|envoy/, archetype: "gateway" },
    { pattern: /langfuse|latitude|grafana|prometheus|otel|collector/, archetype: "cloud" },
] as const;

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

export type HostShape = {
    hosts: Host[];
    candidateHosts: Host[];
    serviceDependsOn: Map<string, Set<string>>;
};

/**
 * Builds deployment hosts: one per compose file (partial overlays excluded),
 * named from informative path segments, each service bound to its Dockerfile
 * (explicit build.dockerfile, resolved relative to the compose dir when
 * needed, or the images/<name>.Dockerfile convention) and classified by image
 * or name. Environment variants are deduped — a host covered >=50% by a
 * higher-ranked variant (prod > uat > example > unqualified > dev) is
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
            const name = parts.join(" ") || "host";
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
                const image = service.image;
                const imageClass =
                    (image !== undefined && IMAGE_CLASSES.find(({ pattern }) => pattern.test(image))?.archetype) ||
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

    return { hosts, candidateHosts, serviceDependsOn };
}
