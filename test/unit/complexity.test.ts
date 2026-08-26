import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createComplexityScanner, loadComplexityCompiler } from "../../src/lib/complexity";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-complexity-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const twoFunctions = [
    "export function first(a: number): number {",
    "    if (a > 0) return 1;",
    "    return 0;",
    "}",
    "export function second(b: number): number {",
    "    if (b > 0 && b < 10) return 1;",
    "    return 0;",
    "}",
    "",
].join("\n");

writeFileSync(join(repo, "two.ts"), twoFunctions);

describe("loadComplexityCompiler", () => {
    it("given a module without the compiler API, when loaded, then returns null", async () => {
        const partial = { default: { version: "5.9.3" } };
        expect(await loadComplexityCompiler(async () => partial)).toBeNull();
    });

    it("given a loader that rejects, when loaded, then returns null", async () => {
        expect(await loadComplexityCompiler(() => Promise.reject(new Error("not installed")))).toBeNull();
    });

    it("given the installed typescript, when loaded, then returns a usable compiler", async () => {
        const compiler = await loadComplexityCompiler();
        expect(compiler?.createSourceFile).toBeTypeOf("function");
    });
});

describe("createComplexityScanner", () => {
    it("given no compiler, when a file is scanned, then the regex fallback reports sum equal to max", () => {
        const scanner = createComplexityScanner(repo, null);
        const sum = scanner.fileComplexity("two.ts");
        expect(sum).toBe(scanner.fileMaxFunctionComplexity("two.ts"));
        expect(sum).toBeGreaterThan(1);
    });

    it("given the compiler, when a file with two functions is scanned, then complexity is attributed per function", async () => {
        const scanner = createComplexityScanner(repo, await loadComplexityCompiler());
        expect(scanner.fileMaxFunctionComplexity("two.ts")).toBe(3);
        expect(scanner.fileComplexity("two.ts")).toBe(6);
    });
});
