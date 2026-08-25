import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPackages, owningPackage, packageDirsOf } from "../../src/lib/packages";

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
    const allFiles = ["package.json", "packages/tool/package.json", "packages/lib/package.json", "src/a.ts"];
    const dirs = packageDirsOf(allFiles);
    const packages = discoverPackages(repo, dirs);

    it("given package.json files, when dirs are listed, then one dir per manifest", () => {
        expect(dirs).toEqual([".", "packages/tool", "packages/lib"]);
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
});
