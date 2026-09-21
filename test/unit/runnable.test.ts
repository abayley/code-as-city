import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPackages, packageDirsOf } from "../../src/lib/packages";
import { findRunnableApps } from "../../src/lib/runnable";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-run-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function write(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("findRunnableApps", () => {
    it("given a start script targeting a server, when scanned, then it is a server app (D16)", () => {
        write("api/package.json", JSON.stringify({ name: "api", scripts: { start: "bun run src/server.ts" } }));
        write("api/src/server.ts", "Bun.serve({ port: 3000, fetch() { return new Response('ok'); } });\n");
        const files = ["api/package.json", "api/src/server.ts"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        const apps = findRunnableApps(repo, packages, files);
        expect(apps).toEqual([{ pkgDir: "api", entry: "api/src/server.ts", tag: "server" }]);
    });

    it("given a web-role package with a root SPA entry, when scanned, then it is a web app (D16)", () => {
        write("web/package.json", JSON.stringify({ name: "web", private: true, dependencies: { react: "19" } }));
        write("web/index.tsx", "import App from './App';\n");
        write("web/App.tsx", "export default function App() { return null; }\n");
        const files = ["web/package.json", "web/index.tsx", "web/App.tsx"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        const apps = findRunnableApps(repo, packages, files);
        expect(apps).toEqual([{ pkgDir: "web", entry: "web/index.tsx", tag: "app" }]);
    });

    it("given a start script that runs a non-server CLI, when scanned, then it is not a server app (D16)", () => {
        write("tool/package.json", JSON.stringify({ name: "tool", scripts: { start: "bun run src/cli.ts" } }));
        write("tool/src/cli.ts", "console.log('hello');\n");
        const files = ["tool/package.json", "tool/src/cli.ts"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        expect(findRunnableApps(repo, packages, files)).toEqual([]);
    });

    it("given a plain library with no start script and no web role, when scanned, then nothing is runnable (D16)", () => {
        write("lib/package.json", JSON.stringify({ name: "lib", main: "src/index.ts" }));
        write("lib/src/index.ts", "export const x = 1;\n");
        const files = ["lib/package.json", "lib/src/index.ts"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        expect(findRunnableApps(repo, packages, files)).toEqual([]);
    });
});

describe("findRunnableApps (HC-022 framework runners)", () => {
    it("given a start script running a framework command, when scanned, then the app anchors to its router entry (D16, HC-022)", () => {
        write(
            "studio/package.json",
            JSON.stringify({ name: "studio", private: true, scripts: { start: "next start" } }),
        );
        write("studio/app/layout.tsx", "export default function Layout() { return null; }\n");
        write("studio/app/page.tsx", "export default function Page() { return null; }\n");
        const files = ["studio/package.json", "studio/app/layout.tsx", "studio/app/page.tsx"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        const apps = findRunnableApps(repo, packages, files);
        expect(apps).toEqual([{ pkgDir: "studio", entry: "studio/app/layout.tsx", tag: "server" }]);
    });

    it("given a pages-router app, when scanned, then the pages entry anchors the app (D16, HC-022)", () => {
        write("docsapp/package.json", JSON.stringify({ name: "docsapp", scripts: { dev: "next dev" } }));
        write("docsapp/pages/index.tsx", "export default function Page() { return null; }\n");
        const files = ["docsapp/package.json", "docsapp/pages/index.tsx"];
        const packages = discoverPackages(repo, packageDirsOf(files));
        // A dev-only script name is QA/operational split territory; the
        // framework arm matches the "dev" name too — the router entry anchors.
        const apps = findRunnableApps(repo, packages, files);
        expect(apps).toEqual([{ pkgDir: "docsapp", entry: "docsapp/pages/index.tsx", tag: "server" }]);
    });
});
