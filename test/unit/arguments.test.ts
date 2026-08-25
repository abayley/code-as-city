import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/lib/arguments";

describe("parseArguments", () => {
    it("given a target repo only, when parsed, then defaults the out dir to out/<basename>", () => {
        const result = parseArguments(["/some/repo"]);
        expect(result).toEqual({
            repo: resolve("/some/repo"),
            outDir: resolve("out", "repo"),
            modulesAsBuildings: false,
            overview: false,
        });
    });

    it("given --overview, when parsed, then the default out dir gains the -overview suffix", () => {
        const result = parseArguments(["/some/repo", "--overview"]);
        expect(result?.overview).toBe(true);
        expect(result?.outDir).toBe(resolve("out", `${basename("/some/repo")}-overview`));
    });

    it("given --out-dir, when parsed, then it wins over the default", () => {
        const result = parseArguments(["/some/repo", "--out-dir", "/tmp/x"]);
        expect(result?.outDir).toBe(resolve("/tmp/x"));
    });

    it("given --modules-as-buildings, when parsed, then the flag is set", () => {
        expect(parseArguments(["/r", "--modules-as-buildings"])?.modulesAsBuildings).toBe(true);
    });

    it("given no target repo, when parsed, then returns null", () => {
        expect(parseArguments(["--overview"])).toBeNull();
    });
});
