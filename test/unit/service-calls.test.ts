import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containerPort, parseComposeServices } from "../../src/lib/compose";
import type { Host } from "../../src/lib/hosts";
import {
    type EndpointService,
    findEnvRefs,
    findHttpCalls,
    findScrapeTargets,
    findServePaths,
    indexEndpointServices,
    mergeEnvScopes,
    parseEndpoint,
    resolveEnvValue,
    resolveServiceEndpoint,
} from "../../src/lib/service-calls";

const host = (id: string, file = "docker-compose.yml"): Host => ({ file, name: id, id, services: [], rank: 2 });
const target = (
    hostId: string,
    name: string,
    ports: string[] = [],
    image: string | undefined = undefined,
): EndpointService => ({
    host: host(hostId),
    name,
    image,
    ports: ports.map((mapping) => containerPort(mapping)).filter((port): port is string => port !== null),
    copies: [],
    env: {},
});

describe("containerPort", () => {
    it("given port mappings, when read, then the container port is the trailing segment", () => {
        expect(containerPort("3000:3000")).toBe("3000");
        expect(containerPort("127.0.0.1:3000:3000")).toBe("3000");
        expect(containerPort("9090")).toBe("9090");
    });

    it("given ranges and protocols, when read, then nothing resolves", () => {
        expect(containerPort("3000-3005:3000-3005")).toBeNull();
        expect(containerPort("abc")).toBeNull();
    });
});

describe("parseComposeServices ports", () => {
    it("given a ports block, when parsed, then the raw entries are kept", () => {
        const [api] = parseComposeServices(
            ["services:", "  api:", "    ports:", '      - "3000:3000"', "      - 9090"].join("\n"),
        );
        expect(api?.ports).toEqual(["3000:3000", "9090"]);
        expect(api?.hasPorts).toBe(true);
    });
});

describe("findHttpCalls (D19)", () => {
    it("given fetch and axios calls, when scanned, then their static URLs are targets", () => {
        // Concatenated, not interpolated: a template placeholder never
        // resolves, so dynamic URLs are excluded by construction.
        const dynamic = "client.get(`http://svc:3000/` + path);";
        const calls = findHttpCalls(
            [
                'const a = await fetch("http://ml:8000/predict", { method: "POST" });',
                "axios.post('https://api.example.com/v1');",
                dynamic,
            ].join("\n"),
        );
        expect(calls).toEqual([
            { hostname: "ml", port: "8000" },
            { hostname: "api.example.com", port: null },
        ]);
    });

    it("given a URL in a comment, when scanned, then it names no call", () => {
        expect(findHttpCalls("// see http://ml:8000/predict for docs\nconst x = 1;")).toEqual([]);
    });

    it("given a typed-client call, when scanned, then its URL is a target like any call's", () => {
        const calls = findHttpCalls(['const out = await mlClient.post("http://ml:8000/predict", body);'].join("\n"));
        expect(calls).toEqual([{ hostname: "ml", port: "8000" }]);
    });

    it("given client-config properties, when scanned, then their URLs are targets", () => {
        const calls = findHttpCalls(['const client = new ApiClient({ baseURL: "http://ml:8000" });'].join("\n"));
        expect(calls).toEqual([{ hostname: "ml", port: "8000" }]);
    });

    it("given a bare host and port, when parsed, then it reads as http", () => {
        expect(parseEndpoint("ml:8000")).toEqual({ hostname: "ml", port: "8000" });
        expect(parseEndpoint("not a url !!!")).toBeNull();
    });
});

describe("findEnvRefs (D19)", () => {
    it("given JS and Python env reads, when scanned, then the variable names are collected", () => {
        expect(
            findEnvRefs(['const url = process.env.ML_URL ?? "x";', "other = os.environ.get('DB_URL')"].join("\n")),
        ).toEqual(["ML_URL", "DB_URL"]);
    });
});

describe("findServePaths (D21)", () => {
    it("given static-serving calls, when scanned, then the served dirs are found", () => {
        expect(findServePaths(['app.use(express.static("../../web/dist"));'].join("\n"))).toEqual(["../../web/dist"]);
        expect(findServePaths(['app.mount("/s", StaticFiles(directory="../ui/build"), name="s")'].join("\n"))).toEqual([
            "../ui/build",
        ]);
    });
});

describe("indexEndpointServices", () => {
    it("given hosts, when indexed, then ports, copies, and env are normalised once", () => {
        const indexed = indexEndpointServices([
            {
                ...host("host-a"),
                services: [
                    {
                        name: "api",
                        ports: ["3000:3000"],
                        copies: ["packages/api/"],
                        entryFile: null,
                        environment: { ML_URL: "http://ml:8000" },
                    },
                ],
            },
        ]);
        expect(indexed).toEqual([
            {
                host: expect.objectContaining({ id: "host-a" }),
                name: "api",
                image: undefined,
                ports: ["3000"],
                copies: ["packages/api"],
                env: { ML_URL: "http://ml:8000" },
            },
        ]);
    });
});

describe("resolveServiceEndpoint (D19/D20)", () => {
    const services = [target("host-a", "api", ["3000:3000"]), target("host-b", "ml"), target("host-b", "api")];

    it("given a unique service name, when resolved, then it wins without a port", () => {
        expect(resolveServiceEndpoint(services, { hostname: "ml", port: "8000" }, null)?.host.id).toBe("host-b");
    });

    it("given same-named alternatives, when resolved, then a declared port corroborates", () => {
        expect(resolveServiceEndpoint(services, { hostname: "api", port: "3000" }, null)?.host.id).toBe("host-a");
    });

    it("given same-named alternatives and no port, when resolved, then it stays silent", () => {
        expect(resolveServiceEndpoint(services, { hostname: "api", port: null }, null)).toBeNull();
    });

    it("given same-named alternatives, when resolved, then the caller's sibling wins", () => {
        expect(resolveServiceEndpoint(services, { hostname: "api", port: null }, "host-b")?.host.id).toBe("host-b");
    });

    it("given localhost, when resolved, then the declared port decides, uniquely or not at all", () => {
        expect(resolveServiceEndpoint(services, { hostname: "localhost", port: "3000" }, null)?.host.id).toBe("host-a");
        expect(resolveServiceEndpoint(services, { hostname: "localhost", port: "9999" }, null)).toBeNull();
        const dupes = [...services, target("host-c", "other", ["3000:3000"])];
        expect(resolveServiceEndpoint(dupes, { hostname: "localhost", port: "3000" }, null)).toBeNull();
    });

    it("given an unknown host, when resolved, then nothing resolves", () => {
        expect(resolveServiceEndpoint(services, { hostname: "ghost", port: "3000" }, null)).toBeNull();
    });
});

describe("env scopes", () => {
    it("given agreeing scopes, when merged, then later scopes add keys", () => {
        expect(mergeEnvScopes([{ A: "1" }, { B: "2" }])).toEqual({ A: "1", B: "2" });
    });

    it("given disagreeing scopes, when merged, then the key drops out", () => {
        expect(mergeEnvScopes([{ A: "1" }, { A: "2" }])).toEqual({});
    });

    it("given an interpolated value, when resolved, then it reads from the scope", () => {
        // Concatenated: the lint rule flags `${}` even in plain strings.
        expect(resolveEnvValue("http://$" + "{HOST}:8000", { HOST: "ml" })).toBe("http://ml:8000");
        expect(resolveEnvValue("http://$" + "{MISSING}:8000", {})).toBeNull();
        expect(resolveEnvValue("", {})).toBeNull();
    });
});

describe("findScrapeTargets (D20)", () => {
    const repo = mkdtempSync(join(tmpdir(), "code-as-city-scrape-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));
    const write = (path: string, content: string): void => {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), content);
    };
    write(
        "docker/prometheus.yml",
        ["scrape_configs:", "  - job_name: mini", "    static_configs:", '      - targets: ["api:3000"]'].join("\n"),
    );
    write("bridge-template/prometheus.yml", "scrape_configs:\n- targets: ['x:1']\n");
    write("tests/prometheus.yml", "scrape_configs:\n- targets: ['y:2']\n");

    it("given a prometheus config, when scanned, then its quoted scrape targets are found", () => {
        expect(findScrapeTargets(repo, ["docker/prometheus.yml"])).toEqual([
            { config: "docker/prometheus.yml", hostname: "api", port: "3000" },
        ]);
    });

    it("given template and test-path configs, when scanned, then they scrape nothing", () => {
        expect(findScrapeTargets(repo, ["bridge-template/prometheus.yml", "tests/prometheus.yml"])).toEqual([]);
    });
});
