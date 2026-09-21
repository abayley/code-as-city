import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    artefactEntryCandidates,
    discoverPackages,
    owningPackage,
    type Package,
    packageDirsOf,
} from "../../src/lib/packages";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-pkg-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeManifest(dir: string, manifest: object): void {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, "package.json"), JSON.stringify(manifest));
}

describe("packages", () => {
    writeManifest(".", { name: "root", dependencies: { react: "19.0.0" } });
    writeManifest("packages/tool", { name: "@x/tool", bin: { tool: "cli.js" } });
    writeManifest("packages/lib", {});
    writeManifest("packages/pub-lib", { name: "@x/pub-lib", main: "dist/index.js" });
    writeManifest("packages/private-cli", { name: "@x/private-cli", private: true, bin: { pc: "cli.js" } });
    writeManifest("packages/ext", { name: "@x/ext", engines: { vscode: "^1.80.0" }, main: "dist/extension.js" });
    writeManifest("packages/tool-fork", { name: "@x/tool" });
    writeManifest("packages/exp-str", { name: "@x/exp-str", exports: "dist/str.js" });
    writeManifest("packages/exp-root", { name: "@x/exp-root", exports: { ".": "dist/root.js" } });
    writeManifest("packages/exp-cond", { name: "@x/exp-cond", exports: { ".": { import: "dist/cond.mjs" } } });
    writeManifest("packages/exp-none", { name: "@x/exp-none", exports: {} });
    const allFiles = [
        "package.json",
        "packages/tool/package.json",
        "packages/lib/package.json",
        "packages/pub-lib/package.json",
        "packages/private-cli/package.json",
        "packages/ext/package.json",
        "packages/tool-fork/package.json",
        "packages/exp-str/package.json",
        "packages/exp-root/package.json",
        "packages/exp-cond/package.json",
        "packages/exp-none/package.json",
        "src/a.ts",
    ];
    const dirs = packageDirsOf(allFiles);
    const packages = discoverPackages(repo, dirs);

    it("given package.json files, when dirs are listed, then one dir per manifest", () => {
        expect(dirs).toEqual([
            ".",
            "packages/tool",
            "packages/lib",
            "packages/pub-lib",
            "packages/private-cli",
            "packages/ext",
            "packages/tool-fork",
            "packages/exp-str",
            "packages/exp-root",
            "packages/exp-cond",
            "packages/exp-none",
        ]);
    });

    it("given a web-framework dependency, when classified, then the package role is web", () => {
        expect(packages[0]).toMatchObject({ dir: ".", name: "root", role: "web", id: "root" });
    });

    it("given bin entries, when classified, then the package role is cli", () => {
        expect(packages[1]).toMatchObject({ name: "@x/tool", role: "cli", id: "x-tool" });
    });

    it("given no name, when discovered, then the directory basename names the package", () => {
        expect(packages[2]).toMatchObject({ name: "lib", role: "package", id: "lib" });
    });

    it("given nested packages, when owning is resolved, then the deepest match wins", () => {
        expect(owningPackage(packages, "packages/tool/cli.js")?.name).toBe("@x/tool");
        expect(owningPackage(packages, "src/a.ts")?.name).toBe("root");
    });

    const byName = (name: string) => packages.find((p) => p.name === name);

    it("given a non-private bin package, when classified, then it is a published CLI artefact (D14)", () => {
        expect(byName("@x/tool")?.artefact).toEqual({ kind: "cli", tag: "cli", entry: "cli.js", types: null });
    });

    it("given a non-private package with main, when classified, then it is a published library artefact (D14)", () => {
        expect(byName("@x/pub-lib")?.artefact).toEqual({
            kind: "library",
            tag: "published",
            entry: "dist/index.js",
            types: null,
        });
    });

    it("given a private bin package, when classified, then it is not a published artefact (D14)", () => {
        expect(byName("@x/private-cli")?.artefact).toBeNull();
    });

    it("given an engines.vscode package, when classified, then it is a published extension artefact (D14)", () => {
        expect(byName("@x/ext")?.artefact).toEqual({
            kind: "extension",
            tag: "extension",
            entry: "dist/extension.js",
            types: null,
        });
    });

    it("given a nameless empty package, when classified, then it is not a published artefact (D14)", () => {
        expect(byName("lib")?.artefact).toBeNull();
    });

    it("given a string exports entry, when classified, then it is the published library entry (D14)", () => {
        expect(byName("@x/exp-str")?.artefact).toEqual({
            kind: "library",
            tag: "published",
            entry: "dist/str.js",
            types: null,
        });
    });

    it("given an exports '.' string subpath, when classified, then that subpath is the entry (D14)", () => {
        expect(byName("@x/exp-root")?.artefact).toEqual({
            kind: "library",
            tag: "published",
            entry: "dist/root.js",
            types: null,
        });
    });

    it("given an exports '.' condition map, when classified, then the import condition is the entry (D14)", () => {
        expect(byName("@x/exp-cond")?.artefact).toEqual({
            kind: "library",
            tag: "published",
            entry: "dist/cond.mjs",
            types: null,
        });
    });

    it("given an empty exports object, when classified, then it is not a published artefact (D14)", () => {
        expect(byName("@x/exp-none")?.artefact).toBeNull();
    });

    it("given two packages sharing a name, when discovered, then their ids are unique (HC-015)", () => {
        const tools = packages.filter((p) => p.name === "@x/tool");
        expect(tools).toHaveLength(2);
        expect(tools[0]?.id).toBe("x-tool");
        expect(tools[1]?.id).toBe("x-tool-2");
    });
});

describe("artefactEntryCandidates (HC-027)", () => {
    const pkg = (dir: string, name: string, entry: string | null, types: string | null = null): Package => ({
        dir,
        name,
        deps: {},
        role: "package",
        id: dir.replace(/\//g, "-"),
        artefact: { kind: "library", tag: "published", entry, types },
    });

    it("given a declared entry with a leading ./, when resolved, then the . segment is normalised away", () => {
        const candidates = pkg("packages/ext", "@x/ext", "./dist/extension.js").artefact
            ? artefactEntryCandidates(pkg("packages/ext", "@x/ext", "./dist/extension.js"))
            : [];
        expect(candidates).toContain("packages/ext/src/extension.ts");
        expect(candidates.some((c) => c.includes("/./"))).toBe(false);
    });

    it("given a package name unlike the declared entry, when resolved, then the name-derived source entries are candidates", () => {
        const candidates = artefactEntryCandidates(pkg("packages/mermaid", "mermaid", "./dist/mermaid.core.mjs"));
        expect(candidates).toContain("packages/mermaid/src/mermaid.ts");
        expect(candidates).toContain("packages/mermaid/mermaid.ts");
    });

    it("given a types entry pointing at a d.ts, when resolved, then the d.ts maps to its source", () => {
        const candidates = artefactEntryCandidates(
            pkg("packages/zenuml", "@mermaid-js/zenuml", "./dist/core.mjs", "./dist/detector.d.ts"),
        );
        expect(candidates).toContain("packages/zenuml/src/detector.ts");
        expect(candidates).toContain("packages/zenuml/detector.ts");
    });

    it("given a scoped package name, when resolved, then only the last segment derives the entry", () => {
        const candidates = artefactEntryCandidates(pkg("packages/parser", "@mermaid-js/parser", null));
        expect(candidates).toContain("packages/parser/src/parser.ts");
    });
});
