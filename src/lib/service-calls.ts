// Service-to-service edges: HTTP calls between sibling services and
// monitoring scrapes (HEURISTICS.md rules D19/D20, HC-023). Both resolve a
// literal target — a hostname or a port — against the declared compose
// topology, and both stay silent when the target does not resolve to exactly
// one declared service: HTTP-target matching is where guesses start.

import { join } from "node:path";
import { containerPort } from "./compose.ts";
import { normaliseCopyDir } from "./copy-attribution.ts";
import type { Host } from "./hosts.ts";
import { isTestPath } from "./inventory.ts";
import { readText } from "./read.ts";
import { stripJsComments } from "./text.ts";

/** An endpoint hostname/port pair, as parsed from a URL or env value. */
export type Endpoint = { hostname: string; port: string | null };

/**
 * A declared service indexed for endpoint resolution: identity plus the
 * normalised match material, computed once so the matcher reads its own
 * struct rather than reaching into `HostService` per comparison.
 */
export type EndpointService = {
    host: Host;
    name: string;
    /** Container image, for the prometheus scraper rule (D20). */
    image: string | undefined;
    /** Declared container ports, parsed once from the raw mappings. */
    ports: string[];
    /** Normalised D3 copy dirs, for file-to-service attribution. */
    copies: string[];
    /** Literal compose `environment:` entries. */
    env: Record<string, string>;
};

/**
 * Indexes hosts' services for endpoint resolution.
 *
 * @param hosts - The hosts whose services are indexed.
 * @returns One entry per service, with match material normalised.
 */
export function indexEndpointServices(hosts: readonly Host[]): EndpointService[] {
    return hosts.flatMap((host) =>
        host.services.map((service) => ({
            host,
            name: service.name,
            image: service.image,
            ports: (service.ports ?? [])
                .map((mapping) => containerPort(mapping))
                .filter((port): port is string => port !== null),
            copies: (service.copies ?? []).map((copy) => normaliseCopyDir(copy)),
            env: { ...(service.environment ?? {}) },
        })),
    );
}

/**
 * Normalises a hostname or service name for comparison: lowercase with
 * non-alphanumerics stripped (the M5 convention), so `immich-server`,
 * `immich_server`, and `immichserver` compare equal.
 *
 * @param name - A hostname or compose service name.
 * @returns The normalised comparison key.
 */
function normaliseName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * D19/D20: resolves an endpoint target to the single declared service it
 * names. A non-loopback hostname must match a service name (its first DNS
 * label counts, so `ml.internal` still resolves); a loopback hostname
 * (`localhost`, `127.0.0.1`) resolves by declared container port. Several
 * same-named services (HC-020 alternatives) resolve to the caller's
 * same-host sibling, if any — otherwise, and whenever a port names several
 * services, the target is ambiguous and resolves to nothing. Silence here is
 * the spec's own risk directive (HC-023): drawing to every same-named
 * alternative would reintroduce the duplication HC-020 just removed.
 *
 * @param services - The indexed services to match against (callers pass
 *   only services with emitted nodes, so a shadowed duplicate never wins).
 * @param endpoint - The call/scrape target's hostname and port.
 * @param callerHostId - The caller's host district id, or null when the
 *   caller is not a hosted service.
 * @returns The resolved service, or null when nothing resolves unambiguously.
 */
export function resolveServiceEndpoint(
    services: readonly EndpointService[],
    endpoint: Endpoint,
    callerHostId: string | null,
): EndpointService | null {
    const { hostname, port } = endpoint;
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if (loopback) {
        if (port === null) return null;
        const matches = services.filter((target) => target.ports.includes(port));
        return matches.length === 1 ? (matches[0] ?? null) : null;
    }
    const key = normaliseName(hostname.split(".")[0] ?? hostname);
    let matches = services.filter((target) => normaliseName(target.name) === key);
    if (!matches.length) return null;
    // A declared port corroborates the name: several same-named services
    // (HC-020 alternatives) collapse to the one actually listening on it.
    if (port !== null) {
        const corroborated = matches.filter((target) => target.ports.includes(port));
        if (corroborated.length) matches = corroborated;
    }
    const sameHost = matches.find((target) => target.host.id === callerHostId);
    if (sameHost) return sameHost;
    return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Merges env scopes with conflict-dropping: a key every scope agrees on (or
 * only one scope sets) survives; scopes disagreeing on a key drop it, since
 * no static read can tell which value the file sees.
 *
 * @param scopes - The env maps in increasing precedence (later scopes set
 *   new keys, but a conflicting value drops the key outright).
 * @returns The agreed entries.
 */
export function mergeEnvScopes(scopes: readonly Record<string, string>[]): Record<string, string> {
    const merged: Record<string, string> = {};
    const conflicted = new Set<string>();
    for (const scope of scopes) {
        for (const [key, value] of Object.entries(scope)) {
            if (conflicted.has(key)) continue;
            if (key in merged && merged[key] !== value) {
                delete merged[key];
                conflicted.add(key);
            } else {
                merged[key] = value;
            }
        }
    }
    return merged;
}

/**
 * Resolves one raw env value against a scope: `${NAME}` interpolations read
 * from the scope in a single pass. Key-only pass-throughs from the shell are
 * statically unknowable and stay silent, as does anything still holding an
 * interpolation afterwards.
 *
 * @param raw - The raw env value as declared.
 * @param scope - The merged env scope to interpolate from.
 * @returns The resolved value, or null when it resolves to nothing usable.
 */
export function resolveEnvValue(raw: string, scope: Record<string, string>): string | null {
    let missing = false;
    const value = raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
        const found = scope[name];
        if (found === undefined) missing = true;
        return found ?? "";
    });
    if (!value || missing || /\$\{/.test(value)) return null;
    return value;
}

// A static http(s) URL passed to any call: `fetch("http://...")`,
// `client.post("http://...")`, `redirect("http://...")` — the call-verb list
// is deliberately open, since a typed SDK client's methods are unknowable
// statically. Precision still holds at resolution: only a URL naming exactly
// one declared service draws. In single- or double-quoted strings only (see
// below); a logged URL naming a sibling still draws, by decision.
const CALL_URL_PATTERN =
    /\b(?!(?:if|while|for|switch|return|typeof|catch)\b)[A-Za-z_$][\w$]*(?:\.\w+)*\s*\([^()]*?['"](https?:\/\/[^'"\s$]+)['"]/g;

// A static http(s) URL in an SDK/client-config property: baseURL, endpoint,
// and their dash- or underscore-spelled siblings, in JS/TS (`baseURL:
// "..."`) or Python (`base_url = "..."`) spelling.
const CONFIG_URL_PATTERN =
    /\b(?:base[-_]?url|endpoint|api[-_]?url|server[-_]?url|service[-_]?url|url|uri)\s*[:=]\s*['"](https?:\/\/[^'"\s$]+)['"]/gi;

/**
 * Parses a raw endpoint string into a hostname/port pair: a bare
 * `host:port` (an env value without a scheme) is read as http.
 *
 * @param raw - The endpoint string as written.
 * @returns The hostname/port pair, or null when it parses as no http URL.
 */
export function parseEndpoint(raw: string): Endpoint | null {
    for (const candidate of [raw, `http://${raw}`]) {
        let url: URL;
        try {
            url = new URL(candidate);
        } catch {
            continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || null };
    }
    return null;
}

// Environment-variable reads: `process.env.X` (JS/TS), `os.environ["X"]` /
// `.get("X")` / `.X` and `os.getenv("X")` (Python). The value resolves
// through the deploying services' compose `environment:` entries.
const ENV_REF_PATTERNS = [
    /process\.env\.([A-Za-z0-9_]+)/g,
    /os\.environ(?:\[["']([A-Za-z0-9_]+)["']\]|\.get\(["']([A-Za-z0-9_]+)["']\)|\.([A-Za-z0-9_]+))/g,
    /os\.getenv\(["']([A-Za-z0-9_]+)["']\)/g,
];

/**
 * D19: the environment variables a source file reads a URL from. Resolution
 * against compose `environment:` values happens in the assembly phase, which
 * sees the deploying services; here only the referenced names are collected.
 *
 * @param text - The source file's full text.
 * @returns The referenced variable names, in first-use order.
 */
export function findEnvRefs(text: string): string[] {
    const stripped = stripJsComments(text);
    const refs: string[] = [];
    for (const pattern of ENV_REF_PATTERNS) {
        for (const match of stripped.matchAll(pattern)) {
            const name = match.slice(1).find((group) => group !== undefined);
            if (name !== undefined && !refs.includes(name)) refs.push(name);
        }
    }
    return refs;
}

// Static-asset serving: `express.static("<dir>")` (Express) and
// `StaticFiles(directory="<dir>")` (FastAPI/Starlette). The served dir names
// the shipped app — usually build output that is never inventoried, so the
// edge targets the owning package's entry, resolved in the assembly phase.
const SERVE_PATH_PATTERNS = [
    /\.static\s*\(\s*['"`]([^'"`$]+)['"`]/g,
    /StaticFiles\s*\(\s*directory\s*=\s*['"`]([^'"`$]+)['"`]/g,
];

/**
 * D21: the directories a source file serves as static assets.
 *
 * @param text - The source file's full text.
 * @returns The served paths as written.
 */
export function findServePaths(text: string): string[] {
    const stripped = stripJsComments(text);
    const paths: string[] = [];
    for (const pattern of SERVE_PATH_PATTERNS) {
        for (const match of stripped.matchAll(pattern)) {
            const served = match[1];
            if (served !== undefined && !paths.includes(served)) paths.push(served);
        }
    }
    return paths;
}

/**
 * D19: the static HTTP call targets in a source file: every single- or
 * double-quoted http(s) URL passed to a call or set on a client-config
 * property, comments stripped (a URL in prose names no call). Dynamic URLs
 * (template literals, concatenation) resolve to nothing and are excluded
 * here.
 *
 * @param text - The source file's full text.
 * @returns One hostname/port pair per static call URL.
 */
export function findHttpCalls(text: string): Endpoint[] {
    const stripped = stripJsComments(text);
    const patterns = [CALL_URL_PATTERN, CONFIG_URL_PATTERN];
    const calls: Endpoint[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
        for (const match of stripped.matchAll(pattern)) {
            const raw = match[1];
            if (raw === undefined) continue;
            const endpoint = parseEndpoint(raw);
            // The call-arg and config patterns overlap (a constructed client's
            // URL matches both): one relationship, one target.
            if (endpoint && !seen.has(`${endpoint.hostname}:${endpoint.port ?? ""}`)) {
                seen.add(`${endpoint.hostname}:${endpoint.port ?? ""}`);
                calls.push(endpoint);
            }
        }
    }
    return calls;
}

/** One scrape target from a prometheus config: which host:port a job scrapes. */
export type ScrapeTarget = { config: string; hostname: string; port: string };

/**
 * D20: the scrape targets a prometheus config declares. Only files named
 * `prometheus.yml`/`prometheus.yaml` outside test paths and template dirs
 * (a config copied into user projects scrapes nothing from this repo, as
 * D7's template guard holds) are read, and only `host:port` tokens inside
 * the `scrape_configs:` block — a port elsewhere in the file (a listen
 * address, a comment) is not a scrape.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param allFiles - The full repo inventory, searched for prometheus configs.
 * @returns The declared scrape targets with their config attribution.
 */
export function findScrapeTargets(repo: string, allFiles: readonly string[]): ScrapeTarget[] {
    const targets: ScrapeTarget[] = [];
    for (const file of allFiles) {
        if (!/(^|\/)prometheus\.ya?ml$/.test(file)) continue;
        if (isTestPath(file)) continue;
        if (/(^|\/)[^/]*template[^/]*\//i.test(file)) continue;
        const text = readText(join(repo, file));
        const blockStart = text.search(/scrape_configs:/);
        if (blockStart === -1) continue;
        const block = text.slice(blockStart);
        // Quoted host:port tokens only: the `-` sits on the `static_configs:`
        // line, not the `targets:` line, while an unquoted match would also
        // catch port mappings and comments elsewhere in the block.
        for (const match of block.matchAll(/['"]([A-Za-z0-9_.-]+:\d+)['"]/g)) {
            const token = match[1];
            if (token === undefined) continue;
            const separator = token.lastIndexOf(":");
            targets.push({
                config: file,
                hostname: token.slice(0, separator),
                port: token.slice(separator + 1),
            });
        }
    }
    return targets;
}
