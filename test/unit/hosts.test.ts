import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildHosts } from "../../src/lib/hosts";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-hosts-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("buildHosts", () => {
    writeFile(
        "docker-compose.yml",
        ["services:", "  api:", "    dockerfile: api/Dockerfile", "  db:", "    image: postgres:16"].join("\n"),
    );
    writeFile(
        "docker-compose.dev.yml",
        ["services:", "  api:", "    depends_on:", "      - cache", "  cache:", "    image: redis:7"].join("\n"),
    );
    writeFile("api/Dockerfile", 'FROM node\nCOPY api/src api/src\nCMD ["node", "api/src/main.ts"]');
    const allFiles = ["docker-compose.yml", "docker-compose.dev.yml", "api/Dockerfile", "api/src/main.ts"];
    const composeFiles = ["docker-compose.yml", "docker-compose.dev.yml"];
    const schedules = new Map([["api", { schedule: "0 3 * * *", crontab: "crontab" }]]);
    const { hosts, candidateHosts, serviceDependsOn } = buildHosts(repo, allFiles, composeFiles, schedules);

    it("given an unqualified and a dev variant, when deduped, then the unqualified host survives", () => {
        expect(hosts.map((h) => h.file)).toEqual(["docker-compose.yml"]);
        expect(candidateHosts).toHaveLength(2);
    });

    it("given a bound Dockerfile, when built, then the service carries copies, entry file, and schedule", () => {
        const api = hosts[0]?.services.find((s) => s.name === "api");
        expect(api).toMatchObject({
            dockerfile: "api/Dockerfile",
            copies: ["api/src"],
            entryFile: "api/src/main.ts",
            schedule: "0 3 * * *",
        });
    });

    it("given a postgres image, when classified, then the service is a database", () => {
        expect(hosts[0]?.services.find((s) => s.name === "db")?.imageClass).toBe("database");
    });

    it("given depends_on only in the deduped variant, when harvested, then it still informs wiring", () => {
        expect(serviceDependsOn.get("api")).toEqual(new Set(["cache"]));
    });

    it("given postgres-derived images that are not databases, when classified, then they are not databases (D5)", () => {
        writeFile(
            "pgrest/docker-compose.yml",
            [
                "services:",
                "  rest:",
                "    image: postgrest/postgrest:latest",
                "  meta:",
                "    image: supabase/postgres-meta:v0.80.0",
                "  store:",
                "    image: supabase/postgres:15.1.0.147",
            ].join("\n"),
        );
        const built = buildHosts(repo, ["pgrest/docker-compose.yml"], ["pgrest/docker-compose.yml"], new Map());
        const services = built.hosts[0]?.services ?? [];
        expect(services.find((s) => s.name === "rest")?.imageClass).toBeUndefined();
        expect(services.find((s) => s.name === "meta")?.imageClass).toBeUndefined();
        expect(services.find((s) => s.name === "store")?.imageClass).toBe("database");
    });

    it("given a root compose whose path yields no informative segment, when named, then the host falls back to the repo name (D2)", () => {
        writeFile(
            "rootcompose/docker-compose.yml",
            ["services:", "  api:", "    image: node:20", "  db:", "    image: postgres:16"].join("\n"),
        );
        const built = buildHosts(
            repo,
            ["rootcompose/docker-compose.yml"],
            ["rootcompose/docker-compose.yml"],
            new Map(),
        );
        // "rootcompose" is a generic-free segment, so it is informative and used.
        expect(built.hosts[0]?.name).toBe("rootcompose");
    });

    it("given a compose at the repo root, when named, then the host falls back to the repo basename, not 'host' (D2)", () => {
        writeFile("docker-compose.yml", ["services:", "  app:", "    image: node:20"].join("\n"));
        const built = buildHosts(repo, ["docker-compose.yml"], ["docker-compose.yml"], new Map());
        expect(built.hosts[0]?.name).toBe(basename(repo));
        expect(built.hosts[0]?.name).not.toBe("host");
    });

    it("given a service in a canonical and a topology compose, when owners resolve, then the canonical host owns it (D1)", () => {
        writeFile(
            "topo/docker-compose.yml",
            [
                "services:",
                "  db:",
                "    image: postgres:16",
                "  api:",
                "    image: node:20",
                "  web:",
                "    image: nginx",
            ].join("\n"),
        );
        writeFile(
            "topo/docker-compose.s3.yml",
            [
                "services:",
                "  db:",
                "    image: postgres:16",
                "  minio:",
                "    image: minio/minio",
                "  minio-setup:",
                "    image: minio/mc",
            ].join("\n"),
        );
        const built = buildHosts(
            repo,
            ["topo/docker-compose.yml", "topo/docker-compose.s3.yml"],
            ["topo/docker-compose.yml", "topo/docker-compose.s3.yml"],
            new Map(),
        );
        const canonical = built.hosts.find((h) => h.file === "topo/docker-compose.yml");
        const topology = built.hosts.find((h) => h.file === "topo/docker-compose.s3.yml");
        expect(canonical).toBeDefined();
        expect(topology).toBeDefined();
        // db recurs in both surviving hosts; the canonical file owns it.
        expect(built.serviceOwner.get(`topo db`)).toBe(canonical?.id);
        // minio is unique to the topology host, which owns it.
        expect(built.serviceOwner.get(`topo minio`)).toBe(topology?.id);
    });

    it("given a service across two topology composes with no canonical, when owners resolve, then the lower filename wins (D1)", () => {
        writeFile("q/docker-compose.a.yml", ["services:", "  db:", "    image: postgres:16"].join("\n"));
        writeFile("q/docker-compose.b.yml", ["services:", "  db:", "    image: postgres:16"].join("\n"));
        const built = buildHosts(
            repo,
            ["q/docker-compose.a.yml", "q/docker-compose.b.yml"],
            ["q/docker-compose.a.yml", "q/docker-compose.b.yml"],
            new Map(),
        );
        const a = built.hosts.find((h) => h.file === "q/docker-compose.a.yml");
        expect(built.serviceOwner.get(`q db`)).toBe(a?.id);
    });
});
