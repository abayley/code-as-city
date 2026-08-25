import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseDockerfile } from "../../src/lib/dockerfile";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-df-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function withDockerfile(content: string, allFiles: readonly string[]) {
    writeFileSync(join(repo, "Dockerfile"), content);
    return parseDockerfile(repo, "Dockerfile", allFiles);
}

describe("parseDockerfile", () => {
    it("given COPY lines, when parsed, then keeps only inventoried sources and drops flags", () => {
        const result = withDockerfile(
            ["FROM node", "COPY --chown=x:x scripts /s", "COPY packages/api /app", "COPY missing /m"].join("\n"),
            ["packages/api/src/server.ts"],
        );
        expect(result.copies).toEqual(["packages/api"]);
    });

    it("given an exec-form CMD, when parsed, then the first inventoried token is the entry file", () => {
        const result = withDockerfile('FROM node\nCMD ["node", "packages/api/src/server.ts"]', [
            "packages/api/src/server.ts",
        ]);
        expect(result.entryFile).toBe("packages/api/src/server.ts");
    });

    it("given a shell-form ENTRYPOINT, when parsed, then tokens are split on whitespace", () => {
        const result = withDockerfile("FROM node\nENTRYPOINT node src/main.ts --flag", ["src/main.ts"]);
        expect(result.entryFile).toBe("src/main.ts");
    });

    it("given no entry naming an inventoried file, when parsed, then entryFile is null", () => {
        const result = withDockerfile('FROM node\nCMD ["node", "dist/bundle.js"]', ["src/main.ts"]);
        expect(result.entryFile).toBeNull();
    });
});
