import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findSpawnedEntries } from "../../src/lib/daemons";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-daemon-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function write(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("findSpawnedEntries", () => {
    it("given a literal spawn target that resolves, when scanned, then it is a daemon (D15)", () => {
        write("src/index.ts", "import { spawn } from 'node:child_process';\nspawn('./worker.ts', []);\n");
        write("src/worker.ts", "// daemon\n");
        const inventory = new Set(["src/index.ts", "src/worker.ts"]);
        const found = findSpawnedEntries(repo, ["src/index.ts"], inventory);
        expect(found).toEqual([{ caller: "src/index.ts", target: "src/worker.ts" }]);
    });

    it("given a new Worker(new URL(...)) literal, when scanned, then the worker script is a daemon (D15)", () => {
        write("src/main.ts", "const w = new Worker(new URL('./job.ts', import.meta.url));\n");
        write("src/job.ts", "// worker\n");
        const inventory = new Set(["src/main.ts", "src/job.ts"]);
        const found = findSpawnedEntries(repo, ["src/main.ts"], inventory);
        expect(found).toEqual([{ caller: "src/main.ts", target: "src/job.ts" }]);
    });

    it("given a .js literal resolving to a .ts source, when scanned, then the ts entry is the daemon (D15)", () => {
        write("src/boot.ts", "spawn('./daemon.js');\n");
        write("src/daemon.ts", "// daemon\n");
        const inventory = new Set(["src/boot.ts", "src/daemon.ts"]);
        const found = findSpawnedEntries(repo, ["src/boot.ts"], inventory);
        expect(found).toEqual([{ caller: "src/boot.ts", target: "src/daemon.ts" }]);
    });

    it("given a spawn on a variable, when scanned, then nothing is drawn (D15)", () => {
        write("src/var.ts", "const cmd = resolve();\nspawn(cmd, args);\n");
        const found = findSpawnedEntries(repo, ["src/var.ts"], new Set(["src/var.ts"]));
        expect(found).toEqual([]);
    });

    it("given a spawn of an external command, when scanned, then nothing is drawn (D15)", () => {
        write("src/ext.ts", "spawn('systemctl', ['restart', 'x']);\n");
        const found = findSpawnedEntries(repo, ["src/ext.ts"], new Set(["src/ext.ts"]));
        expect(found).toEqual([]);
    });
});
