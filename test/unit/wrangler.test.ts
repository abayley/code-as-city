import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findEdgeHost } from "../../src/lib/wrangler";

describe("findEdgeHost (D7)", () => {
    const repo = mkdtempSync(join(tmpdir(), "code-as-city-wr-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it("given a toml config, when found, then the worker name and entry resolve", () => {
        writeFileSync(join(repo, "wrangler.toml"), 'name = "edge-worker"\nmain = "src/worker.ts"\n');
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "worker.ts"), "export {};\n");
        expect(findEdgeHost(repo, ["wrangler.toml", "src/worker.ts"])?.name).toBe("edge-worker");
    });
});

describe("findEdgeHost (HC-024 template guard)", () => {
    it("given only a wrangler config under a template dir, when found, then there is no edge host (HC-024)", () => {
        const repo = mkdtempSync(join(tmpdir(), "code-as-city-wr2-"));
        const cfg = join(repo, "packages/plugins/cloudflare/bridge-template/wrangler.jsonc");
        mkdirSync(dirname(cfg), { recursive: true });
        writeFileSync(cfg, '{ "name": "bridge", "main": "src/index.ts" }');
        mkdirSync(join(repo, "packages/plugins/cloudflare/bridge-template/src"), { recursive: true });
        writeFileSync(join(repo, "packages/plugins/cloudflare/bridge-template/src/index.ts"), "export {};\n");
        expect(findEdgeHost(repo, ["packages/plugins/cloudflare/bridge-template/wrangler.jsonc"])).toBeNull();
        rmSync(repo, { recursive: true, force: true });
    });

    it("given a real config beside a template one, when found, then the real config wins (HC-024)", () => {
        const repo = mkdtempSync(join(tmpdir(), "code-as-city-wr3-"));
        const tpl = join(repo, "packages/x/bridge-template/wrangler.jsonc");
        const real = join(repo, "wrangler.toml");
        mkdirSync(dirname(tpl), { recursive: true });
        writeFileSync(tpl, '{ "name": "bridge-template" }');
        writeFileSync(real, 'name = "real-worker"\n');
        const host = findEdgeHost(repo, ["packages/x/bridge-template/wrangler.jsonc", "wrangler.toml"]);
        expect(host?.name).toBe("real-worker");
        rmSync(repo, { recursive: true, force: true });
    });
});
