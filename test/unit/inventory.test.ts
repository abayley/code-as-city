import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extensionOf, inventory, isTestPath } from "../../src/lib/inventory";

describe("isTestPath", () => {
    it("given a file inside a test directory, when classified, then it is a test path", () => {
        expect(isTestPath("packages/api/test/server.test.ts")).toBe(true);
        expect(isTestPath("src/__tests__/x.ts")).toBe(true);
    });

    it("given a test-suffixed filename outside test dirs, when classified, then it is a test path", () => {
        expect(isTestPath("src/thing.spec.ts")).toBe(true);
        expect(isTestPath("src/thing_test.go")).toBe(true);
    });

    it("given ordinary source, when classified, then it is not a test path", () => {
        expect(isTestPath("src/server.ts")).toBe(false);
        expect(isTestPath("src/latest/x.ts")).toBe(false);
    });
});

describe("extensionOf", () => {
    it("given a filename with an extension, when read, then returns it with the dot", () => {
        expect(extensionOf("a/b/c.test.ts")).toBe(".ts");
    });

    it("given no extension, when read, then returns the empty string", () => {
        expect(extensionOf("Dockerfile")).toBe("");
    });
});

describe("inventory (fs-walk fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "code-as-city-inv-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("given ignored, hidden, and workflow dirs, when inventoried, then only keeps real sources sorted", () => {
        mkdirSync(join(root, "src"));
        mkdirSync(join(root, "node_modules", "x"), { recursive: true });
        mkdirSync(join(root, ".github", "workflows"), { recursive: true });
        mkdirSync(join(root, ".hidden"));
        writeFileSync(join(root, "src", "b.ts"), "");
        writeFileSync(join(root, "src", "a.ts"), "");
        writeFileSync(join(root, "node_modules", "x", "dep.js"), "");
        writeFileSync(join(root, ".github", "workflows", "ci.yml"), "");
        writeFileSync(join(root, ".hidden", "secret.ts"), "");
        expect(inventory(root)).toEqual([".github/workflows/ci.yml", "src/a.ts", "src/b.ts"]);
    });
});

describe("inventory (HC-022 member-package yield)", () => {
    const root = mkdtempSync(join(tmpdir(), "code-as-city-inv2-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("given a docs dir that is its own workspace package, when inventoried, then the member package is kept", () => {
        // supabase's apps/docs: a deployed Next.js site swallowed by the
        // "docs" ignore segment. A member package yields.
        mkdirSync(join(root, "apps", "docs", "src"), { recursive: true });
        writeFileSync(
            join(root, "apps", "docs", "package.json"),
            JSON.stringify({ name: "docs", main: "src/index.ts" }),
        );
        writeFileSync(join(root, "apps", "docs", "src", "index.ts"), "export const x = 1;\n");
        expect(inventory(root)).toContain("apps/docs/src/index.ts");
    });

    it("given a plain docs dir and a dist with a package.json, when inventoried, then both stay ignored", () => {
        mkdirSync(join(root, "guides", "docs"), { recursive: true });
        writeFileSync(join(root, "guides", "docs", "intro.md"), "# intro\n");
        mkdirSync(join(root, "packages", "x", "dist"), { recursive: true });
        writeFileSync(join(root, "packages", "x", "dist", "package.json"), "{}");
        writeFileSync(join(root, "packages", "x", "dist", "index.js"), "export {};\n");
        const files = inventory(root);
        expect(files.some((f) => f.startsWith("guides/docs/"))).toBe(false);
        expect(files.some((f) => f.startsWith("packages/x/dist/"))).toBe(false);
    });
});
