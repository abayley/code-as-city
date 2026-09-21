// Runnable-app deployables (HEURISTICS.md rule D16): an app you run directly,
// with no compose, wrangler, or published-package declaration — a server
// started from a `start`/`serve` script, or a web SPA whose entry sits at its
// package root. Complements D14 (published artefacts) for the "run it" case.

import { join } from "node:path";
import type { Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";

/** A package that is run directly, and the source entry that runs it. */
export type RunnableApp = { pkgDir: string; entry: string; tag: "server" | "app" };

// A source form that starts a listening server (mirrors the deployment map's M7
// listen classification): Bun.serve, a `.listen(` call, createServer, fastify,
// or an express() app.
const SERVER_START = /Bun\.serve|\.listen\s*\(|createServer\s*\(|@fastify|express\s*\(\)/;

// A script whose name is (or contains) `start` or `serve`: the operational run
// command for the package.
const RUN_SCRIPT = /(^|[:._-])(start|serve)([:._-]|$)/i;

// An app-framework runner command: `next start`, `next dev`, `nuxt dev`,
// `astro preview`. A package run this way IS the running app even though the
// command names a binary, not a source file (HC-022).
const FRAMEWORK_RUN = /(^|[\s/])(next|nuxt|astro|svelte-kit)\s+(start|dev|preview|serve)\b/;

// The router dirs a framework app's pages/components live in, in preference
// order — the framework arm anchors the runnable app's entry to the first
// inventoried file under one of these.
const ROUTER_DIRS = ["app", "pages", "src/app", "src/pages"];

// Conventional web SPA entry files, in preference order (the mount entry before
// the app component).
const WEB_ENTRY_NAMES = ["index.tsx", "main.tsx", "index.jsx", "main.jsx", "App.tsx", "app.tsx"];

type Manifest = { scripts?: Record<string, string> };

/**
 * Resolves a script-command path token to an inventoried source file within the
 * package, applying the dist->src and `.m/cjs`->`.ts` conventions.
 *
 * @param pkgDir - The package's repo-relative directory ("." for the root).
 * @param token - A whitespace-split word from the script command.
 * @param inventory - The source files a token may resolve to.
 * @returns The repo-relative source file, or null.
 */
function resolveScriptTarget(pkgDir: string, token: string, inventory: ReadonlySet<string>): string | null {
    const clean = token.replace(/^["']|["']$/g, "");
    if (!/[./]/.test(clean) || clean.startsWith("-")) return null;
    const base = pkgDir === "." ? clean : `${pkgDir}/${clean}`;
    const candidates = [base, base.replace(/(^|\/)dist\//, "$1src/").replace(/\.[mc]?js$/, ".ts")];
    return candidates.find((candidate) => inventory.has(candidate)) ?? null;
}

/**
 * D16: classifies each package that is run directly. A web-role package with a
 * root SPA entry is a web app; a package whose `start`/`serve` script targets
 * source that starts a server is a server. Detection is web-app first, then
 * server; a package that is neither yields nothing.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param packages - The discovered packages.
 * @param sourceFiles - Repo-relative source files, used to resolve entries.
 * @returns One entry per runnable package, in package order.
 */
export function findRunnableApps(
    repo: string,
    packages: readonly Package[],
    sourceFiles: readonly string[],
): RunnableApp[] {
    const inventory = new Set(sourceFiles);
    const inPkg = (dir: string, rel: string) => (dir === "." ? rel : `${dir}/${rel}`);
    const apps: RunnableApp[] = [];
    for (const pkg of packages) {
        if (pkg.role === "web") {
            const entry = WEB_ENTRY_NAMES.map((name) => inPkg(pkg.dir, name))
                .concat(WEB_ENTRY_NAMES.map((name) => inPkg(pkg.dir, `src/${name}`)))
                .find((candidate) => inventory.has(candidate));
            if (entry !== undefined) {
                apps.push({ pkgDir: pkg.dir, entry, tag: "app" });
                continue;
            }
        }
        const manifest = (readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {}) as Manifest;
        const runScript = Object.entries(manifest.scripts ?? {}).find(([name]) => RUN_SCRIPT.test(name));
        if (runScript !== undefined) {
            const target = runScript[1]
                .split(/\s+/)
                .map((token) => resolveScriptTarget(pkg.dir, token, inventory))
                .find((resolved): resolved is string => resolved !== null);
            if (target !== undefined && SERVER_START.test(readText(join(repo, target)))) {
                apps.push({ pkgDir: pkg.dir, entry: target, tag: "server" });
                continue;
            }
        }
        // HC-022: an app-framework run command (`next start`, `nuxt dev`) — the
        // package is the running app even though the command names a binary.
        // The entry anchors to the router dir's first inventoried file.
        const frameworkScript = Object.entries(manifest.scripts ?? {}).find(([, command]) =>
            FRAMEWORK_RUN.test(command),
        );
        if (frameworkScript !== undefined) {
            const entry = sourceFiles.find((file) =>
                ROUTER_DIRS.some((dir) => file.startsWith(`${inPkg(pkg.dir, dir)}/`)),
            );
            if (entry !== undefined) {
                apps.push({ pkgDir: pkg.dir, entry, tag: "server" });
            }
        }
    }
    return apps;
}
