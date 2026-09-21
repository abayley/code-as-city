import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    it("given a ./-prefixed COPY, when parsed, then the leading ./ is normalised to the inventory path", () => {
        const result = withDockerfile(
            ["FROM node", "COPY ./server ./server/", "COPY ./packages/plugin-sdk ./packages/plugin-sdk/"].join("\n"),
            ["server/src/main.ts", "packages/plugin-sdk/src/index.ts"],
        );
        expect(result.copies).toEqual(["server", "packages/plugin-sdk"]);
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

    it("given an ENTRYPOINT interpreter followed by a CMD script, when parsed, then the CMD names the entry file", () => {
        const result = withDockerfile('FROM oven/bun\nENTRYPOINT ["bun", "run"]\nCMD ["src/worker.ts"]', [
            "src/worker.ts",
        ]);
        expect(result.entryFile).toBe("src/worker.ts");
    });

    it("given an earlier stage whose entry is not inventoried, when parsed, then a later stage's entry still wins", () => {
        const result = withDockerfile(
            ["FROM node AS build", 'CMD ["node", "dist/build.js"]', "FROM node", 'CMD ["node", "src/main.ts"]'].join(
                "\n",
            ),
            ["src/main.ts"],
        );
        expect(result.entryFile).toBe("src/main.ts");
    });

    it("given a build context, when parsed, then COPY sources and entry tokens resolve against the context (D3, HC-017)", () => {
        mkdirSync(join(repo, "machine-learning/immich_ml"), { recursive: true });
        writeFileSync(
            join(repo, "machine-learning/Dockerfile"),
            ["FROM python", "COPY immich_ml immich_ml", 'CMD ["python", "immich_ml/__main__.py"]'].join("\n"),
        );
        const result = parseDockerfile(
            repo,
            "machine-learning/Dockerfile",
            ["machine-learning/immich_ml/app.py", "machine-learning/immich_ml/__main__.py"],
            "machine-learning",
        );
        expect(result.copies).toEqual(["machine-learning/immich_ml"]);
        expect(result.entryFile).toBe("machine-learning/immich_ml/__main__.py");
    });

    it("given a CMD running a dev server, when parsed, then the dev-server signal is set (REVIEW-0010)", () => {
        writeFileSync(join(repo, "Dockerfile"), 'FROM node\nCMD ["npm", "run", "dev"]');
        expect(parseDockerfile(repo, "Dockerfile", ["src/main.ts"]).devServer).toBe(true);
    });

    it("given a production CMD, when parsed, then the dev-server signal is unset (REVIEW-0010)", () => {
        writeFileSync(join(repo, "Dockerfile"), 'FROM node\nCMD ["node", "src/main.ts"]');
        expect(parseDockerfile(repo, "Dockerfile", ["src/main.ts"]).devServer ?? false).toBe(false);
    });
});
