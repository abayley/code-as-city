import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPackages, packageDirsOf } from "../../src/lib/packages";
import { findSiteHosts } from "../../src/lib/sites";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-sites-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("findSiteHosts (D18)", () => {
    writeFile("package.json", JSON.stringify({ name: "root", private: true }));
    writeFile("packages/web/package.json", JSON.stringify({ name: "@x/web" }));
    writeFile("packages/web/vercel.json", JSON.stringify({ buildCommand: "npm run build", outputDirectory: "dist" }));
    writeFile("packages/site/netlify.toml", ["[build]", 'command = "npm run build"', 'publish = "public"'].join("\n"));
    writeFile("packages/site/package.json", JSON.stringify({ name: "@x/site" }));
    writeFile("bridge-template/wrangler-site/netlify.toml", '[build]\ncommand = "x"\n');
    writeFile("tests/fixture/vercel.json", JSON.stringify({}));
    const allFiles = [
        "package.json",
        "packages/web/package.json",
        "packages/web/vercel.json",
        "packages/site/package.json",
        "packages/site/netlify.toml",
        "bridge-template/wrangler-site/netlify.toml",
        "tests/fixture/vercel.json",
    ];
    const packages = discoverPackages(repo, packageDirsOf(allFiles));
    const sites = findSiteHosts(repo, allFiles, packages);

    it("given platform configs, when found, then one site per config owned by its package", () => {
        expect(sites).toMatchObject([
            { file: "packages/web/vercel.json", platform: "vercel", pkgDir: "packages/web" },
            { file: "packages/site/netlify.toml", platform: "netlify", pkgDir: "packages/site" },
        ]);
    });

    it("given a vercel config, when found, then the build command and output dir are read", () => {
        expect(sites[0]).toMatchObject({ buildCommand: "npm run build", publishDir: "dist" });
    });

    it("given a netlify config, when found, then the build table is read", () => {
        expect(sites[1]).toMatchObject({ buildCommand: "npm run build", publishDir: "public" });
    });

    it("given template and test-path configs, when found, then they declare no site", () => {
        expect(sites.some((s) => s.file.includes("template") || s.file.includes("tests"))).toBe(false);
    });
});
