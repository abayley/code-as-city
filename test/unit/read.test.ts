import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readJson, readJsonSafe, readText } from "../../src/lib/read";

const dir = mkdtempSync(join(tmpdir(), "code-as-city-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readJsonSafe", () => {
    it("given valid JSON text, when parsed, then returns the value", () => {
        expect(readJsonSafe('{"a": 1}')).toEqual({ a: 1 });
    });

    it("given invalid JSON text, when parsed, then returns undefined", () => {
        expect(readJsonSafe("nope {")).toBeUndefined();
    });
});

describe("readJson", () => {
    it("given a JSON file, when read, then returns the parsed value", () => {
        const path = join(dir, "ok.json");
        writeFileSync(path, '{"b": 2}');
        expect(readJson(path)).toEqual({ b: 2 });
    });

    it("given a missing file, when read, then returns undefined", () => {
        expect(readJson(join(dir, "missing.json"))).toBeUndefined();
    });
});

describe("readText", () => {
    it("given a text file, when read, then returns its contents", () => {
        const path = join(dir, "ok.txt");
        writeFileSync(path, "hello");
        expect(readText(path)).toBe("hello");
    });

    it("given a missing file, when read, then returns the empty string", () => {
        expect(readText(join(dir, "missing.txt"))).toBe("");
    });
});
