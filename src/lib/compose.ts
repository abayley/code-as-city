// docker-compose file parsing: the services a compose file declares, with the
// fields the deployment-shape rules need (HEURISTICS.md group D, notably
// D1/D3/D5/D6).

export type ComposeService = {
    name: string;
    image?: string | undefined;
    context?: string | undefined;
    dockerfile?: string | undefined;
    hasPorts?: boolean | undefined;
    /** HC-023: the raw `ports:` entries (`"3000:3000"`, `"9090"`), for service-call and scrape matching. */
    ports?: string[] | undefined;
    /** HC-024: the service bind-mounts the repo root — a dev environment, not a deployment. */
    devBindMount?: boolean | undefined;
    /** REVIEW-0010: the service's command runs a known dev server. */
    devServerCommand?: boolean | undefined;
    /** HC-023: literal `environment:` entries, for env-indirected URL resolution. */
    environment?: Record<string, string> | undefined;
    volumesIndent?: number | undefined;
    dependsOn?: string[] | undefined;
    dependsOnIndent?: number | undefined;
    portsIndent?: number | undefined;
    envIndent?: number | undefined;
};

/**
 * HC-023: the container port a `ports:` entry exposes — the trailing segment
 * (`"3000:3000"` and `"127.0.0.1:3000:3000"` expose 3000, bare `"9090"`
 * exposes 9090). Ranges (`3000-3005:...`) and protocols are not resolved and
 * yield null, so scrape/call matching never fires on a half-parsed range.
 *
 * @param mapping - A raw `ports:` entry as parsed above.
 * @returns The container port, or null when the entry names none exactly.
 */
export function containerPort(mapping: string): string | null {
    const port = (mapping.split(":").at(-1) ?? "").split("/")[0] ?? "";
    return /^\d+$/.test(port) ? port : null;
}

// A dev-server run command (REVIEW-0010): any of these in a service's
// `command:` marks a dev environment rather than a deployment.
const DEV_SERVER_PATTERN =
    /\b(next dev|vite|nodemon|storybook|webpack serve|npm run dev|pnpm dev|yarn dev|bun run dev|tsc --watch)\b/i;

/**
 * Minimal indentation-based parse of a compose file's services block.
 * Only recognises 2-space-indented service entries under a top-level
 * `services:` key (the convention every fixture and target repo uses);
 * deeper indentation is not parsed.
 *
 * @param text - The compose file's full text.
 * @returns The declared services in file order, each with any image,
 *   dockerfile, ports flag, and depends_on entries found under it.
 */
export function parseComposeServices(text: string): ComposeService[] {
    const lines = text.split("\n");
    const services: ComposeService[] = [];
    let inServices = false;
    let current: ComposeService | null = null;
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
        const serviceName = /^([a-zA-Z0-9_-]+):\s*$/.exec(key)?.[1];
        if (indent === servicesIndent + 2 && serviceName !== undefined) {
            current = { name: serviceName };
            services.push(current);
            continue;
        }
        if (!current) continue;
        const image = /^image:\s*(.+)$/.exec(key)?.[1];
        if (image !== undefined) current.image = image.trim();
        const context = /^context:\s*(.+)$/.exec(key)?.[1];
        if (context !== undefined) current.context = context.trim();
        const dockerfile = /^dockerfile:\s*(.+)$/.exec(key)?.[1];
        if (dockerfile !== undefined) current.dockerfile = dockerfile.trim();
        if (/^ports:\s*$/.test(key)) {
            current.hasPorts = true;
            current.portsIndent = indent;
            current.ports ??= [];
            continue;
        }
        if (current.portsIndent !== undefined && indent > current.portsIndent) {
            const mapping = /^-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(key)?.[1];
            if (mapping !== undefined) current.ports?.push(mapping);
        } else if (current.portsIndent !== undefined && indent <= current.portsIndent) {
            current.portsIndent = undefined;
        }
        // REVIEW-0010: a command running a known dev server is a dev
        // environment, not a deployment.
        if (/^(command|cmd):/.test(key) && DEV_SERVER_PATTERN.test(key)) current.devServerCommand = true;
        // HC-024: a bind mount of the repo root (`- .:/work`) is how a dev
        // container mounts your checkout — no image would ever ship that way.
        if (/^volumes:\s*$/.test(key)) {
            current.volumesIndent = indent;
            continue;
        }
        if (current.volumesIndent !== undefined && indent > current.volumesIndent) {
            if (/^-\s*\.\/?\s*:/.test(key)) current.devBindMount = true;
        } else if (current.volumesIndent !== undefined && indent <= current.volumesIndent) {
            current.volumesIndent = undefined;
        }
        if (/^depends_on:\s*$/.test(key)) {
            current.dependsOnIndent = indent;
            current.dependsOn ??= [];
            continue;
        }
        if (current.dependsOnIndent !== undefined && indent > current.dependsOnIndent) {
            const dep = (/^-\s*([a-zA-Z0-9_-]+)\s*$/.exec(key) ?? /^([a-zA-Z0-9_-]+):\s*$/.exec(key))?.[1];
            if (dep !== undefined) current.dependsOn?.push(dep);
        } else if (current.dependsOnIndent !== undefined && indent <= current.dependsOnIndent) {
            current.dependsOnIndent = undefined;
        }
        // HC-023: literal environment entries, so an env-indirected base URL
        // (ML_URL=http://ml:8000) resolves to a declared service. Key-only
        // entries and interpolated values resolve to nothing and are skipped.
        if (/^environment:\s*$/.test(key)) {
            current.envIndent = indent;
            current.environment ??= {};
            continue;
        }
        if (current.envIndent !== undefined && indent > current.envIndent) {
            const entry = (
                /^-\s*([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*$/.exec(key) ?? /^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(key)
            )?.slice(1);
            const envName = entry?.[0];
            const rawValue = entry?.[1]?.replace(/^["']|["']$/g, "");
            if (envName !== undefined && rawValue !== undefined && rawValue !== "" && !rawValue.includes("${")) {
                if (current.environment) current.environment[envName] = rawValue;
            }
        } else if (current.envIndent !== undefined && indent <= current.envIndent) {
            current.envIndent = undefined;
        }
    }
    return services;
}
