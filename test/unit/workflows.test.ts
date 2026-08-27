import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CiWorkflow, scanCiWorkflows } from "../../src/lib/workflows";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-wf-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

/**
 * Writes the given workflow files, then scans them. The inventory always names
 * an entry file the invocation tests reference, so a repo entry can resolve.
 */
function scan(workflows: Record<string, string>): CiWorkflow[] {
    const files = ["scripts/deploy.ts", "scripts/run.ts", ...Object.keys(workflows)];
    for (const path of Object.keys(workflows)) writeFile(path, workflows[path] ?? "");
    return scanCiWorkflows(repo, files);
}

describe("scanCiWorkflows", () => {
    it("given a cron workflow invoking a repo entry with a subcommand, when scanned, then both are recorded (D9/D10)", () => {
        const workflows = scan({
            ".github/workflows/nightly.yml": [
                "name: Nightly",
                "on:",
                "  schedule:",
                "    - cron: '0 2 * * *'",
                "jobs:",
                "  run:",
                "    steps:",
                "      - run: bun scripts/deploy.ts publish",
            ].join("\n"),
        });
        expect(workflows).toEqual([
            {
                file: ".github/workflows/nightly.yml",
                name: "Nightly",
                cron: "0 2 * * *",
                triggeredBy: [],
                invocations: [{ file: "scripts/deploy.ts", sub: "publish" }],
                storage: null,
            },
        ]);
    });

    it("given an inline workflow_run list, when scanned, then the upstream names are recorded", () => {
        const [workflow] = scan({
            ".github/workflows/chained-inline.yml": [
                "name: Chained",
                "on:",
                "  workflow_run:",
                "    workflows: ['Sync corpus', \"Build\"]",
                "    types: [completed]",
                "jobs:",
                "  go:",
                "    steps:",
                "      - run: bun scripts/run.ts",
            ].join("\n"),
        });
        expect(workflow?.triggeredBy).toEqual(["Sync corpus", "Build"]);
    });

    it("given a block workflow_run list, when scanned, then the upstream names are recorded", () => {
        const [workflow] = scan({
            ".github/workflows/chained-block.yml": [
                "name: Chained Block",
                "on:",
                "  workflow_run:",
                "    workflows:",
                "      - 'Sync corpus'",
                "      - Build",
                "    types: [completed]",
                "jobs:",
                "  go:",
                "    steps:",
                "      - run: bun scripts/run.ts",
            ].join("\n"),
        });
        expect(workflow?.triggeredBy).toEqual(["Sync corpus", "Build"]);
    });

    it("given an aws s3 sync to and from s3://, when scanned, then storage records both directions (D11)", () => {
        const [workflow] = scan({
            ".github/workflows/backup.yml": [
                "name: Backup",
                "on:",
                "  schedule:",
                "    - cron: '0 0 * * *'",
                "jobs:",
                "  sync:",
                "    steps:",
                "      - run: |",
                "          aws s3 cp s3://bucket/in ./local",
                "          aws s3 sync ./local s3://bucket/out",
            ].join("\n"),
        });
        expect(workflow?.storage).toEqual({ downloads: true, uploads: true, label: "S3 object storage" });
    });

    it("given an R2 endpoint in the file, when scanned, then the storage label names Cloudflare R2 (D11)", () => {
        const [workflow] = scan({
            ".github/workflows/r2.yml": [
                "name: R2 upload",
                "on:",
                "  schedule:",
                "    - cron: '0 0 * * *'",
                "env:",
                "  ENDPOINT: https://acct.r2.cloudflarestorage.com",
                "jobs:",
                "  up:",
                "    steps:",
                "      - run: aws s3 cp ./dist s3://bucket/dist",
            ].join("\n"),
        });
        expect(workflow?.storage).toEqual({ downloads: false, uploads: true, label: "Cloudflare R2" });
    });

    it("given a workflow with no cron, upstream, or invocation, when scanned, then it is dropped", () => {
        const workflows = scan({
            ".github/workflows/lint.yml": [
                "name: Lint",
                "on: [push]",
                "jobs:",
                "  lint:",
                "    steps:",
                "      - run: bun run lint",
            ].join("\n"),
        });
        expect(workflows).toEqual([]);
    });

    it("given a workflow file with no name, when scanned, then the filename names it", () => {
        const [workflow] = scan({
            ".github/workflows/deploy.yml": ["on:", "  schedule:", "    - cron: '5 4 * * *'", "jobs: {}"].join("\n"),
        });
        expect(workflow?.name).toBe("deploy");
    });
});
