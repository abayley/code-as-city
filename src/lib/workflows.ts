import { basename, join } from "node:path";
import { extensionOf, SOURCE_EXTENSIONS } from "./inventory.ts";
import { readText } from "./read.ts";

type WorkflowInvocation = { file: string; sub: string | null };

export type CiWorkflow = {
    file: string;
    name: string;
    cron: string | null;
    triggeredBy: string[];
    invocations: WorkflowInvocation[];
    storage: { downloads: boolean; uploads: boolean; label: string } | null;
};

/**
 * GitHub Actions workflows are deployment shape too: a scheduled or chained
 * workflow that runs repo code is a job host (D9). Line-based parse: name,
 * cron, workflow_run upstreams, run-step commands, repo entry invocations
 * (D10), and object-storage traffic (D11). Workflows with none of cron,
 * upstreams, or invocations are dropped.
 */
export function scanCiWorkflows(repo: string, allFiles: readonly string[]): CiWorkflow[] {
    const fileExists = (p: string) => allFiles.includes(p);
    const workflowFiles = allFiles.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    const ciWorkflows: CiWorkflow[] = [];
    for (const file of workflowFiles) {
        const text = readText(join(repo, file));
        const lines = text.split("\n");
        const name = (/^name:\s*(.+)$/m.exec(text)?.[1] ?? basename(file).replace(/\.ya?ml$/, ""))
            .trim()
            .replace(/^['"]|['"]$/g, "");
        const cron = /-\s*cron:\s*['"]?([^'"#\n]+)/.exec(text)?.[1]?.trim() ?? null;
        // workflow_run upstreams: inline list (workflows: ['Sync corpus']) or block list.
        const triggeredBy: string[] = [];
        const workflowRunIndex = lines.findIndex((line) => /^\s*workflow_run:\s*$/.test(line));
        if (workflowRunIndex >= 0) {
            for (let i = workflowRunIndex + 1; i < lines.length; i += 1) {
                const line = lines[i];
                if (line === undefined || !/^\s+\S/.test(line)) break;
                const inline = /^\s*workflows:\s*\[([^\]]+)\]/.exec(line)?.[1];
                if (inline !== undefined) {
                    triggeredBy.push(...inline.split(",").map((w) => w.trim().replace(/^['"]|['"]$/g, "")));
                    break;
                }
                if (/^\s*workflows:\s*$/.test(line)) {
                    for (let j = i + 1; j < lines.length; j += 1) {
                        const itemLine = lines[j];
                        if (itemLine === undefined) break;
                        const item = /^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(itemLine)?.[1];
                        if (item === undefined) break;
                        triggeredBy.push(item);
                    }
                    break;
                }
            }
        }
        // Run-step commands: inline `run: cmd` and block `run: |` bodies.
        const commands: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line === undefined) continue;
            const runMatch = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
            if (!runMatch) continue;
            const indent = runMatch[1] ?? "";
            const rest = runMatch[2] ?? "";
            if (rest && !/^[|>]/.test(rest)) {
                commands.push(rest);
                continue;
            }
            for (let j = i + 1; j < lines.length; j += 1) {
                const body = lines[j];
                if (body === undefined) break;
                const bodyIndent = body.length - body.trimStart().length;
                if (body.trim() && bodyIndent <= indent.length) break;
                if (body.trim()) commands.push(body.trim());
            }
        }
        // Repo entry invocations: a command token naming an existing source file,
        // optionally followed by a subcommand word (D10).
        const invocations: WorkflowInvocation[] = [];
        for (const command of commands) {
            const tokens = command.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
            tokens.forEach((token, index) => {
                if (!fileExists(token) || !SOURCE_EXTENSIONS.has(extensionOf(token))) return;
                const next = tokens[index + 1];
                const sub =
                    next && /^[a-z][a-z0-9-]*$/.test(next) && !next.startsWith("-") && !fileExists(next) ? next : null;
                if (!invocations.some((inv) => inv.file === token && inv.sub === sub))
                    invocations.push({ file: token, sub });
            });
        }
        // Object-storage traffic: aws s3 cp/sync/mv with an s3:// source or
        // destination; an R2 endpoint anywhere in the file names the store (D11).
        const storage = { downloads: false, uploads: false };
        for (const command of commands) {
            const copy = /\bs3\s+(?:cp|sync|mv)\s+(\S+)\s+(\S+)/.exec(command);
            if (!copy) continue;
            const source = (copy[1] ?? "").replace(/^["']/, "");
            const destination = (copy[2] ?? "").replace(/^["']/, "");
            if (source.startsWith("s3://")) storage.downloads = true;
            if (destination.startsWith("s3://")) storage.uploads = true;
        }
        const storageLabel = /r2\.cloudflarestorage\.com/i.test(text) ? "Cloudflare R2" : "S3 object storage";
        if (cron || triggeredBy.length || invocations.length) {
            ciWorkflows.push({
                file,
                name,
                cron,
                triggeredBy,
                invocations,
                storage: storage.downloads || storage.uploads ? { ...storage, label: storageLabel } : null,
            });
        }
    }
    return ciWorkflows;
}
