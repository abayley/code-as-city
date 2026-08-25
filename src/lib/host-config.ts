import { basename, dirname, join } from "node:path";
import type { Host, HostService } from "./hosts.ts";
import { readText } from "./read.ts";

export type HostScanResult = {
    host: Host;
    externals: { candidate: string; config: string; envToken: string }[];
    hostTargets: Set<string>;
    // Every host-name match as a (config, other-host) event, in scan order —
    // hostTargets also gains entries from service-name matches, so consumers
    // needing only the host-name matches (with config attribution) read this.
    hostTargetMatches: { otherHost: string; config: string }[];
    serviceTargets: { service: HostService; otherHost: string; config: string }[];
    configs: string[];
};

const ENV_TOKEN_NOISE_WORDS = [
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
];

/**
 * Host config scan: externals, host-to-host forwarding, host-to-service
 * forwarding — computed once, used for districts, infra, and edges. Configs
 * are the host dir's non-compose YAML files sharing a host-name qualifier;
 * env-token endpoints not matching any internal name become external
 * candidates; export lines naming another host or a service (>=6 chars)
 * declare forwarding.
 */
export function scanHostConfigs(repo: string, allFiles: readonly string[], hosts: readonly Host[]): HostScanResult[] {
    return hosts.map((host) => {
        const hostDir = dirname(host.file);
        const hostQualifiers = host.name.split(" ").filter(Boolean);
        const result: HostScanResult = {
            host,
            externals: [],
            hostTargets: new Set(),
            hostTargetMatches: [],
            serviceTargets: [],
            configs: [],
        };
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
                if (envToken === undefined) return;
                const windowText = rawLines
                    .slice(Math.max(0, index - 4), index + 5)
                    .join(" ")
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "");
                if ([...internalNames].some((name) => name.length >= 4 && windowText.includes(name))) return;
                const candidate = envToken
                    .split("_")
                    .filter((word) => !ENV_TOKEN_NOISE_WORDS.includes(word))
                    .join(" ")
                    .toLowerCase();
                if (candidate.length >= 4 && !result.externals.some((e) => e.candidate === candidate)) {
                    result.externals.push({ candidate, config, envToken });
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
                    result.hostTargetMatches.push({ otherHost: other.name, config });
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
}

/**
 * Host flow bands from the declared forwarding chain: roots that forward but
 * are forwarded to by nothing sit at layer 0, targets one deeper per hop;
 * hosts outside the chain default to 0.
 */
export function layerHosts(hostScan: readonly HostScanResult[], hosts: readonly Host[]): Map<string, number> {
    const hostLayer = new Map<string, number>();
    const forwardingHosts = new Set(
        hostScan.flatMap((scan) => (scan.hostTargets.size ? [scan.host.name, ...scan.hostTargets] : [])),
    );
    for (const scan of hostScan) {
        if (
            forwardingHosts.has(scan.host.name) &&
            ![...hostScan].some((other) => other.hostTargets.has(scan.host.name))
        ) {
            hostLayer.set(scan.host.name, 0);
        }
    }
    for (let pass = 0; pass <= hosts.length; pass += 1) {
        let changed = false;
        for (const scan of hostScan) {
            const current = hostLayer.get(scan.host.name);
            if (current === undefined) continue;
            for (const target of scan.hostTargets) {
                const proposed = current + 1;
                if ((hostLayer.get(target) ?? -1) < proposed && proposed <= hosts.length) {
                    hostLayer.set(target, proposed);
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    for (const host of hosts) if (!hostLayer.has(host.name)) hostLayer.set(host.name, 0);
    return hostLayer;
}
