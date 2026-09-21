// Repository file inventory: which files exist and which count as source
// (HEURISTICS.md group I: git listing, nested-repo and ignore-set exclusion,
// test and config filtering).

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "coverage",
    ".wrangler",
    ".turbo",
    "out",
    "vendor",
    ".venv",
    "__pycache__",
    ".functionary",
    ".repo-city",
    "generated",
    "docs",
    "examples",
    "data",
]);
// Content dirs whose ignore can YIELD (HC-022): when one carries its own
// package.json it is a workspace member package (supabase's apps/docs, a
// deployed Next.js site), not prose. Build-output and dependency dirs are
// never yieldable — bundlers write package.json into dist/.
const YIELDABLE_DIRS = new Set(["docs", "examples", "data"]);
const yieldChecked = new Map<string, boolean>();

/**
 * Whether a path is excluded by the ignore set, honouring HC-022's yield: a
 * content dir with its own package.json is a member package and stays in the
 * inventory. The yield result is memoised per directory.
 *
 * @param file - Repo-relative path.
 * @param root - Absolute path of the repository being mapped.
 * @returns True when some parent segment is an ignored dir that does not yield.
 */
function excludedByIgnoredDir(file: string, root: string): boolean {
    const parts = file.split(sep);
    for (let depth = 1; depth < parts.length; depth += 1) {
        const seg = parts[depth - 1];
        if (seg === undefined || !IGNORED_DIRS.has(seg)) continue;
        if (YIELDABLE_DIRS.has(seg)) {
            const dir = parts.slice(0, depth).join(sep);
            const absDir = join(root, dir);
            let yields = yieldChecked.get(absDir);
            if (yields === undefined) {
                yields = existsSync(join(absDir, "package.json"));
                yieldChecked.set(absDir, yields);
            }
            if (yields) continue;
        }
        return true;
    }
    return false;
}

// Entry-like file basenames: exactly cli/cmd/main, or the *-cli / *-command
// suffix convention (redeploy-cli.ts, delivery-command.ts). Shared by both
// map modes.
export const ENTRY_FILE_PATTERN = /(^|[-_.])(cli|cmd|command|main)$/;
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "test-database", "testing"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/;

/**
 * Lists the repository's files: prefer `git ls-files` (respects .gitignore,
 * excludes vendored checkouts); fall back to a directory walk. Either way,
 * exclude nested git repositories (vendored third-party code) and
 * generated/dependency dirs. Sorted, repo-relative paths.
 *
 * @param root - Absolute path of the repository being mapped.
 * @returns Sorted repo-relative paths of every inventoried file.
 */
export function inventory(root: string): string[] {
    let files: string[] | null = null;
    if (existsSync(join(root, ".git"))) {
        const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        files = result.status === 0 ? result.stdout.split("\0").filter(Boolean) : null;
    }
    files ??= walk(root);
    const nestedRepos = new Set<string>();
    for (const file of files) {
        const parts = file.split(sep);
        for (let depth = 1; depth < parts.length; depth += 1) {
            const dir = parts.slice(0, depth).join(sep);
            if (!nestedRepos.has(dir) && existsSync(join(root, dir, ".git"))) nestedRepos.add(dir);
        }
    }
    return files
        .filter((f) => ![...nestedRepos].some((dir) => f.startsWith(dir + sep)))
        .filter((f) => !excludedByIgnoredDir(f, root))
        .sort();
}

/**
 * Fallback directory walk for non-git repos: skips dotfiles (except
 * .github), the ignore-set dirs, and nested git checkouts.
 *
 * @param root - Absolute path of the directory to walk.
 * @returns Sorted root-relative paths of every file found.
 */
function walk(root: string): string[] {
    const files: string[] = [];
    const stack = [root];
    for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
        // Unreadable dirs (macOS-protected bundles like Photos Library) are
        // skipped rather than crashing the walk.
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") && entry.name !== ".github") continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                // HC-022: an ignored content dir with its own package.json is a
                // member package — walk into it.
                const yields = YIELDABLE_DIRS.has(entry.name) && existsSync(join(full, "package.json"));
                if ((!IGNORED_DIRS.has(entry.name) || yields) && !existsSync(join(full, ".git"))) stack.push(full);
            } else if (entry.isFile()) {
                files.push(relative(root, full));
            }
        }
    }
    return files.sort();
}

/**
 * True when the file sits in a test directory or matches the test-file
 * naming convention (I4).
 *
 * @param file - Repo-relative path of the file.
 * @returns Whether the file is excluded from source analysis as a test.
 */
export function isTestPath(file: string): boolean {
    return file.split(sep).some((seg) => TEST_DIRS.has(seg)) || TEST_FILE_PATTERN.test(file);
}

/**
 * The file's extension including the dot, or the empty string.
 *
 * @param file - The file path or name.
 * @returns The extension from the last dot onwards, or "" when dotless.
 */
export function extensionOf(file: string): string {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot);
}
