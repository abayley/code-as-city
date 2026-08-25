import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
});
