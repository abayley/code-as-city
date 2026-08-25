import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCrontabSchedules } from "../../src/lib/crontab";
import { scanCiWorkflows } from "../../src/lib/workflows";
import { findEdgeHost } from "../../src/lib/wrangler";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-scan-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("parseCrontabSchedules", () => {
    it("given compose run lines, when parsed, then maps service to the five cron fields", () => {
        const text = "# comment\n0 3 * * * cd /srv && docker compose run --rm api node x.js\n";
        const schedules = parseCrontabSchedules([["crontab", text]]);
        expect(schedules.get("api")).toEqual({ schedule: "0 3 * * *", crontab: "crontab" });
    });

    it("given lines without a run command, when parsed, then nothing is recorded", () => {
        expect(parseCrontabSchedules([["crontab", "0 1 * * * /usr/bin/uptime\n"]]).size).toBe(0);
    });
});

describe("findEdgeHost", () => {
    it("given a wrangler.toml, when found, then name and repo-relative main are read", () => {
        writeFile("wrangler.toml", 'name = "edge"\nmain = "./src/worker.ts"\n');
        expect(findEdgeHost(repo, ["wrangler.toml"])).toEqual({
            file: "wrangler.toml",
            name: "edge",
            main: "src/worker.ts",
            d1: [],
        });
    });

    it("given a subdirectory wrangler.toml with a config-relative main, when found, then main resolves against the config dir", () => {
        writeFile("packages/sub/wrangler.toml", 'name = "sub-edge"\nmain = "./src/worker.ts"\n');
        const host = findEdgeHost(repo, ["packages/sub/wrangler.toml", "packages/sub/src/worker.ts"]);
        expect(host).toMatchObject({ name: "sub-edge", main: "packages/sub/src/worker.ts" });
    });

    it("given a wrangler.jsonc with comments, when found, then the JSON form is parsed", () => {
        writeFile("packages/e/wrangler.jsonc", '{\n  // comment\n  "name": "w", "main": "src/w.ts"\n}\n');
        const host = findEdgeHost(repo, ["packages/e/wrangler.jsonc"]);
        expect(host).toMatchObject({ name: "w", main: "src/w.ts" });
    });

    it("given no wrangler config, when searched, then returns null", () => {
        expect(findEdgeHost(repo, ["src/a.ts"])).toBeNull();
    });
});

describe("scanCiWorkflows", () => {
    it("given a scheduled workflow invoking repo code, when scanned, then cron and invocation land", () => {
        writeFile(
            ".github/workflows/sync.yml",
            [
                "name: Sync corpus",
                "on:",
                "  schedule:",
                '    - cron: "0 4 * * *"',
                "jobs:",
                "  sync:",
                "    steps:",
                "      - run: bun scripts/sync.ts pull",
            ].join("\n"),
        );
        const [workflow] = scanCiWorkflows(repo, [".github/workflows/sync.yml", "scripts/sync.ts"]);
        expect(workflow).toMatchObject({
            name: "Sync corpus",
            cron: "0 4 * * *",
            invocations: [{ file: "scripts/sync.ts", sub: "pull" }],
        });
    });

    it("given a workflow_run chained workflow with s3 upload, when scanned, then upstream and storage land", () => {
        writeFile(
            ".github/workflows/publish.yml",
            [
                "name: Publish",
                "on:",
                "  workflow_run:",
                "    workflows: ['Sync corpus']",
                "jobs:",
                "  publish:",
                "    steps:",
                "      - run: |",
                "          aws s3 cp dist.tar s3://bucket/dist.tar",
            ].join("\n"),
        );
        const workflows = scanCiWorkflows(repo, [".github/workflows/publish.yml"]);
        expect(workflows[0]).toMatchObject({
            triggeredBy: ["Sync corpus"],
            storage: { downloads: false, uploads: true, label: "S3 object storage" },
        });
    });

    it("given a plain CI workflow with no cron, chain, or repo invocation, when scanned, then it is dropped", () => {
        writeFile(
            ".github/workflows/ci.yml",
            ["name: ci", "on: push", "jobs:", "  test:", "    steps:", "      - run: npm test"].join("\n"),
        );
        expect(scanCiWorkflows(repo, [".github/workflows/ci.yml"])).toEqual([]);
    });
});
