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
// Codebase/dev utilities are detected by reachability, not by name: code
// reachable only from package.json scripts and imported by nothing that
// deploys is excluded from the map (see the reachability section).
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
        .filter((f) => !f.split(sep).some((seg) => IGNORED_DIRS.has(seg)))
        .sort();
}

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
                if (!IGNORED_DIRS.has(entry.name) && !existsSync(join(full, ".git"))) stack.push(full);
            } else if (entry.isFile()) {
                files.push(relative(root, full));
            }
        }
    }
    return files.sort();
}

/** True when the file sits in a test directory or matches the test-file naming convention. */
export function isTestPath(file: string): boolean {
    return file.split(sep).some((seg) => TEST_DIRS.has(seg)) || TEST_FILE_PATTERN.test(file);
}

/** The file's extension including the dot, or the empty string. */
export function extensionOf(file: string): string {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot);
}
