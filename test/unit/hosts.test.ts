import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildHosts, isServiceShadowed } from "../../src/lib/hosts";

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
        expect(built.serviceOwner.get(`topo db postgres:16`)).toBe(canonical?.id);
        // minio is unique to the topology host, which owns it.
        expect(built.serviceOwner.get(`topo minio minio/minio`)).toBe(topology?.id);
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
        expect(built.serviceOwner.get(`q db postgres:16`)).toBe(a?.id);
    });

    // HC-020: kong and envoy are alternative gateways that merely share the
    // service name `api-gw`; image identity, not the name, is the fold key.
    // Mirrors supabase: the canonical compose holds the full topology, the
    // kong variant only the alternative gateway.
    it("given the same service name with different images across composes, when owners resolve, then each host keeps its service (D1, HC-020)", () => {
        writeFile(
            "alt/docker-compose.yml",
            [
                "services:",
                "  api-gw:",
                "    image: envoy:1.31",
                "  db:",
                "    image: postgres:16",
                "  rest:",
                "    image: postgrest/postgrest:latest",
            ].join("\n"),
        );
        writeFile("alt/docker-compose.kong.yml", ["services:", "  api-gw:", "    image: kong/kong:3.9.3"].join("\n"));
        writeFile("alt/docker-compose.caddy.yml", ["services:", "  api-gw:", "    image: caddy:2"].join("\n"));
        const built = buildHosts(
            repo,
            ["alt/docker-compose.yml", "alt/docker-compose.kong.yml", "alt/docker-compose.caddy.yml"],
            ["alt/docker-compose.yml", "alt/docker-compose.kong.yml", "alt/docker-compose.caddy.yml"],
            new Map(),
        );
        const canonical = built.hosts.find((h) => h.file === "alt/docker-compose.yml");
        const kong = built.hosts.find((h) => h.file === "alt/docker-compose.kong.yml");
        const caddy = built.hosts.find((h) => h.file === "alt/docker-compose.caddy.yml");
        if (!canonical || !kong || !caddy) throw new Error("expected all alternative-proxy hosts to survive dedup");
        // Same image on db folds to the canonical owner; the gateways stay distinct.
        expect(isServiceShadowed(built.serviceOwner, kong, { name: "api-gw", image: "kong/kong:3.9.3" })).toBe(false);
        expect(isServiceShadowed(built.serviceOwner, kong, { name: "db", image: "postgres:16" })).toBe(true);
    });

    it("given an image-less service sharing a name with an imaged service, when owners resolve, then they stay distinct (D1, HC-020)", () => {
        writeFile(
            "logs/docker-compose.yml",
            [
                "services:",
                "  studio:",
                "    image: studio:1",
                "  vector:",
                "    image: vector:1",
                "  auth:",
                "    image: auth:1",
            ].join("\n"),
        );
        writeFile(
            "logs/docker-compose.logs.yml",
            ["services:", "  studio:", "    depends_on:", "      - vector"].join("\n"),
        );
        const built = buildHosts(
            repo,
            ["logs/docker-compose.yml", "logs/docker-compose.logs.yml"],
            ["logs/docker-compose.yml", "logs/docker-compose.logs.yml"],
            new Map(),
        );
        const canonical = built.hosts.find((h) => h.file === "logs/docker-compose.yml");
        const logs = built.hosts.find((h) => h.file === "logs/docker-compose.logs.yml");
        if (!canonical || !logs) throw new Error("expected both topology hosts to survive dedup");
        // The imaged studio folds to the canonical owner; the image-less logs
        // studio is a distinct service and is not shadowed by it.
        expect(isServiceShadowed(built.serviceOwner, canonical, { name: "studio", image: "studio:1" })).toBe(false);
        expect(isServiceShadowed(built.serviceOwner, logs, { name: "studio", image: undefined })).toBe(false);
    });

    it("given a compose under a test directory, when hosts are built, then it is not a deployment topology (I4 via D1, HC-020)", () => {
        writeFile("tests/docker-compose.rustfs.test.yml", ["services:", "  rustfs:", "    image: rustfs:1"].join("\n"));
        const built = buildHosts(
            repo,
            ["tests/docker-compose.rustfs.test.yml"],
            ["tests/docker-compose.rustfs.test.yml"],
            new Map(),
        );
        expect(built.hosts).toEqual([]);
        expect(built.candidateHosts).toEqual([]);
    });

    it("given a dev-ranked variant its canonical covers by name, when deduped, then the dev variant drops (D1, HC-020)", () => {
        writeFile(
            "dcomp/docker-compose.yml",
            ["services:", "  db:", "    image: postgres:17", "  api:", "    image: api:1"].join("\n"),
        );
        writeFile(
            "dcomp/dev/docker-compose.dev.yml",
            ["services:", "  db:", "    build:", "      context: ."].join("\n"),
        );
        const built = buildHosts(
            repo,
            ["dcomp/docker-compose.yml", "dcomp/dev/docker-compose.dev.yml"],
            ["dcomp/docker-compose.yml", "dcomp/dev/docker-compose.dev.yml"],
            new Map(),
        );
        expect(built.hosts.map((h) => h.file)).toEqual(["dcomp/docker-compose.yml"]);
    });

    it("given a compose service bind-mounting the repo root, when built, then the service is tagged a dev environment (HC-024)", () => {
        writeFile(
            "devd/docker-compose.yml",
            [
                "services:",
                "  dev:",
                "    build:",
                "      context: .",
                "      dockerfile: Dockerfile",
                "    volumes:",
                "      - .:/work",
            ].join("\n"),
        );
        writeFile("devd/Dockerfile", "FROM node\n");
        const built = buildHosts(
            repo,
            ["devd/docker-compose.yml", "devd/Dockerfile"],
            ["devd/docker-compose.yml"],
            new Map(),
        );
        expect(built.hosts[0]?.services[0]).toMatchObject({ devBindMount: true });
    });

    it("given a build block naming only a context, when bound, then the default <context>/Dockerfile is used (D3, HC-017)", () => {
        writeFile("app/docker-compose.yml", ["services:", "  web:", "    build:", "      context: ."].join("\n"));
        writeFile("app/Dockerfile", "FROM nginx\nCOPY app/src app/src\n");
        const built = buildHosts(
            repo,
            ["app/docker-compose.yml", "app/Dockerfile", "app/src/index.ts"],
            ["app/docker-compose.yml"],
            new Map(),
        );
        const web = built.hosts[0]?.services.find((s) => s.name === "web");
        expect(web).toMatchObject({ dockerfile: "app/Dockerfile", copies: ["app/src"] });
    });

    it("given a build dockerfile relative to a context outside the compose dir, when bound, then it resolves against the context (D3, HC-017)", () => {
        writeFile(
            "sub/compose/docker-compose.yml",
            [
                "services:",
                "  ml:",
                "    build:",
                "      context: ../machine-learning",
                "      dockerfile: Dockerfile",
            ].join("\n"),
        );
        writeFile("sub/machine-learning/Dockerfile", "FROM python\nCOPY immich_ml immich_ml\n");
        const built = buildHosts(
            repo,
            [
                "sub/compose/docker-compose.yml",
                "sub/machine-learning/Dockerfile",
                "sub/machine-learning/immich_ml/app.py",
            ],
            ["sub/compose/docker-compose.yml"],
            new Map(),
        );
        const ml = built.hosts[0]?.services.find((s) => s.name === "ml");
        expect(ml).toMatchObject({
            dockerfile: "sub/machine-learning/Dockerfile",
            copies: ["sub/machine-learning/immich_ml"],
        });
    });

    it("given a build block whose context Dockerfile does not exist, when bound, then nothing binds", () => {
        writeFile("ghost/docker-compose.yml", ["services:", "  api:", "    build:", "      context: ."].join("\n"));
        const built = buildHosts(repo, ["ghost/docker-compose.yml"], ["ghost/docker-compose.yml"], new Map());
        const api = built.hosts[0]?.services.find((s) => s.name === "api");
        expect(api?.dockerfile).toBeUndefined();
        expect(api?.copies).toEqual([]);
    });
});

describe("standalone Dockerfiles (HC-018)", () => {
    it("given a Dockerfile with no compose owner, when built, then it becomes a single-service image host", () => {
        writeFile("lone/Dockerfile", 'FROM node:20-slim\nCOPY lone/src lone/src\nCMD ["node", "lone/src/main.ts"]');
        const built = buildHosts(repo, ["lone/Dockerfile", "lone/src/main.ts"], [], new Map());
        expect(built.hosts).toHaveLength(1);
        expect(built.hosts[0]).toMatchObject({ file: "lone/Dockerfile" });
        expect(built.hosts[0]?.services).toHaveLength(1);
        expect(built.hosts[0]?.services[0]).toMatchObject({
            name: "app",
            dockerfile: "lone/Dockerfile",
            copies: ["lone/src"],
            entryFile: "lone/src/main.ts",
        });
    });

    it("given a Dockerfile a compose service builds, when built, then it is not drawn twice", () => {
        writeFile("owned/docker-compose.yml", ["services:", "  web:", "    build:", "      context: ."].join("\n"));
        writeFile("owned/Dockerfile", "FROM nginx\n");
        const built = buildHosts(
            repo,
            ["owned/docker-compose.yml", "owned/Dockerfile"],
            ["owned/docker-compose.yml"],
            new Map(),
        );
        expect(built.hosts).toHaveLength(1);
        expect(built.hosts[0]?.file).toBe("owned/docker-compose.yml");
    });

    it("given a Dockerfile under a test path, when built, then it is a fixture, not a host", () => {
        writeFile("tests/fixture/Dockerfile", "FROM node\n");
        const built = buildHosts(repo, ["tests/fixture/Dockerfile"], [], new Map());
        expect(built.hosts).toHaveLength(0);
    });

    it("given Dockerfile name variants, when built, then dash, dot, and lowercase forms all bind (HC-018)", () => {
        writeFile("variants/Dockerfile-prod", 'FROM node\nCMD ["node", "variants/a.ts"]');
        writeFile("variants/dockerfile", 'FROM node\nCMD ["node", "variants/b.ts"]');
        const built = buildHosts(
            repo,
            ["variants/Dockerfile-prod", "variants/dockerfile", "variants/a.ts", "variants/b.ts"],
            [],
            new Map(),
        );
        expect(built.hosts).toHaveLength(2);
    });

    it("given a dev-qualified Dockerfile with a plain CMD, when built, then the service is tagged dev-environment (HC-018)", () => {
        writeFile("devimg/Dockerfile.dev", 'FROM node\nCMD ["node", "devimg/a.ts"]');
        const built = buildHosts(repo, ["devimg/Dockerfile.dev", "devimg/a.ts"], [], new Map());
        expect(built.hosts[0]?.services[0]).toMatchObject({ devEnvironment: true });
    });

    it("given a latest-qualified Dockerfile, when built, then the test-substring does not mark it dev (HC-018)", () => {
        writeFile("latest/Dockerfile-latest", 'FROM node\nCMD ["node", "latest/a.ts"]');
        const built = buildHosts(repo, ["latest/Dockerfile-latest", "latest/a.ts"], [], new Map());
        expect(built.hosts[0]?.services[0]).toMatchObject({ devEnvironment: false });
    });

    it("given a source module named like a variant, when built, then it is code, not a host (HC-018)", () => {
        writeFile("src/lib/dockerfile.ts", "export const x = 1;\n");
        const built = buildHosts(repo, ["src/lib/dockerfile.ts"], [], new Map());
        expect(built.hosts).toHaveLength(0);
    });
});

describe("platform container deployments (HC-025, D22/D23)", () => {
    it("given an ECS task definition, when built, then its containers are a host with ports and dependencies", () => {
        writeFile(
            "docker/ecs-task-definition.json",
            JSON.stringify({
                family: "shop",
                containerDefinitions: [
                    {
                        name: "web",
                        image: "shop/web:latest",
                        portMappings: [{ containerPort: 3000, hostPort: 80 }],
                        dependsOn: [{ containerName: "db", condition: "HEALTHY" }],
                    },
                ],
            }),
        );
        const built = buildHosts(repo, ["docker/ecs-task-definition.json"], [], new Map());
        expect(built.hosts).toHaveLength(1);
        expect(built.hosts[0]).toMatchObject({ name: "shop" });
        expect(built.hosts[0]?.services[0]).toMatchObject({
            name: "web",
            image: "shop/web:latest",
            ports: ["80:3000"],
            hasPorts: true,
        });
        expect(built.serviceDependsOn.get("web")).toEqual(new Set(["db"]));
    });

    it("given a task-definition file with no containers, when built, then it is not a topology", () => {
        writeFile("docker/empty-task-definition.json", JSON.stringify({ family: "empty" }));
        const built = buildHosts(repo, ["docker/empty-task-definition.json"], [], new Map());
        expect(built.hosts).toHaveLength(0);
    });

    it("given quadlet units, when built, then one host holds the containers with scoped dependencies", () => {
        writeFile(
            "docker/quadlet/cache.container",
            ["[Unit]", "After=network-online.target", "", "[Container]", "Image=redis:7", "PublishPort=6379:6379"].join(
                "\n",
            ),
        );
        writeFile(
            "docker/quadlet/app.container",
            ["[Unit]", "After=cache.service", "", "[Container]", "Image=shop/app:latest"].join("\n"),
        );
        const built = buildHosts(
            repo,
            ["docker/quadlet/cache.container", "docker/quadlet/app.container"],
            [],
            new Map(),
        );
        expect(built.hosts).toHaveLength(1);
        const services = built.hosts[0]?.services ?? [];
        expect(services.map((s) => s.name).sort()).toEqual(["app", "cache"]);
        expect(services.find((s) => s.name === "cache")?.imageClass).toBe("queue");
        // cache orders after a systemd target (not a container): no dependency.
        // app orders after the cache container: a dependency.
        expect(built.serviceDependsOn.get("cache")).toBeUndefined();
        expect(built.serviceDependsOn.get("app")).toEqual(new Set(["cache"]));
    });
});
