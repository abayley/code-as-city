import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containerPort, parseComposeServices } from "../../src/lib/compose";
import type { Host } from "../../src/lib/hosts";
import {
    findEnvRefs,
    findHttpCalls,
    findScrapeTargets,
    findServePaths,
    parseEndpoint,
    resolveServiceEndpoint,
    type ServiceTarget,
} from "../../src/lib/service-calls";

const host = (id: string, file = "docker-compose.yml"): Host => ({ file, name: id, id, services: [], rank: 2 });
const target = (hostId: string, name: string, ports: string[] = []): ServiceTarget => ({
    host: host(hostId),
    service: { name, ports, copies: [], entryFile: null },
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

describe("resolveServiceEndpoint (D19/D20)", () => {
    const services = [target("host-a", "api", ["3000:3000"]), target("host-b", "ml"), target("host-b", "api")];

    it("given a unique service name, when resolved, then it wins without a port", () => {
        expect(resolveServiceEndpoint(services, "ml", "8000", null)?.host.id).toBe("host-b");
    });

    it("given same-named alternatives, when resolved, then a declared port corroborates", () => {
        expect(resolveServiceEndpoint(services, "api", "3000", null)?.host.id).toBe("host-a");
    });

    it("given same-named alternatives and no port, when resolved, then it stays silent", () => {
        expect(resolveServiceEndpoint(services, "api", null, null)).toBeNull();
    });

    it("given same-named alternatives, when resolved, then the caller's sibling wins", () => {
        expect(resolveServiceEndpoint(services, "api", null, "host-b")?.host.id).toBe("host-b");
    });

    it("given localhost, when resolved, then the declared port decides, uniquely or not at all", () => {
        expect(resolveServiceEndpoint(services, "localhost", "3000", null)?.host.id).toBe("host-a");
        expect(resolveServiceEndpoint(services, "localhost", "9999", null)).toBeNull();
        const dupes = [...services, target("host-c", "other", ["3000:3000"])];
        expect(resolveServiceEndpoint(dupes, "localhost", "3000", null)).toBeNull();
    });

    it("given an unknown host, when resolved, then nothing resolves", () => {
        expect(resolveServiceEndpoint(services, "ghost", "3000", null)).toBeNull();
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
