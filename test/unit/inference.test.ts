import { describe, expect, it } from "vitest";
import type { Host, HostService } from "../../src/lib/hosts";
import {
    classifiedVariantServices,
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferModuleDataFlows,
    isEntryPoint,
    type NodeIndexEntry,
} from "../../src/lib/inference";
import type { MapEdge } from "../../src/lib/map-types";
import type { EmbeddedDatabase } from "../../src/lib/scans";

const textsOf = (texts: Record<string, string>) => (file: string) => texts[file] ?? "";

const database: EmbeddedDatabase = {
    id: "embedded-duckdb",
    label: "DuckDB",
    depName: "duckdb",
    path: "package.json",
    description: "Embedded database.",
};

describe("inferEmbeddedDatabaseUse", () => {
    const texts = textsOf({
        "src/store.ts": 'import { Database } from "duckdb";',
        "src/other.ts": "export const nothing = 1;",
        "src/report.ts": 'const db = require("duckdb");',
    });

    it("given module entries (overview mode), when a module imports the SDK, then a -u edge targets the database", () => {
        const edges: MapEdge[] = [];
        const entries: NodeIndexEntry[] = [
            { id: "mod-store", files: ["src/store.ts", "src/other.ts"] },
            { id: "mod-plain", files: ["src/other.ts"] },
        ];
        inferEmbeddedDatabaseUse({ databases: [database], entries, edges, fileText: texts, edgeSuffix: "-u" });
        expect(edges).toEqual([
            {
                id: "mod-store--embedded-duckdb-u",
                from: "mod-store",
                to: "embedded-duckdb",
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "reads/writes",
                sourceRefs: [{ path: "package.json" }],
            },
        ]);
    });

    it("given per-file entries (deployment mode), when owners repeat, then importers dedupe in first-match order", () => {
        const edges: MapEdge[] = [];
        const entries: NodeIndexEntry[] = [
            { id: "svc-a", files: ["src/store.ts"] },
            { id: "svc-b", files: ["src/report.ts"] },
            { id: "svc-a", files: ["src/report.ts"] },
        ];
        const importerCalls: (readonly string[])[] = [];
        inferEmbeddedDatabaseUse({
            databases: [database],
            entries,
            edges,
            fileText: texts,
            edgeSuffix: "",
            onImporters: (_db, importers) => importerCalls.push(importers),
        });
        expect(importerCalls).toEqual([["svc-a", "svc-b"]]);
        expect(edges.map((e) => e.id)).toEqual(["svc-a--embedded-duckdb", "svc-b--embedded-duckdb"]);
    });

    // The documented contract: the deployment map parents the database node
    // into its importers' district from this callback, so the node must exist
    // before any edge references it.
    it("given an onImporters callback, when it runs, then no edge has been emitted yet", () => {
        const edges: MapEdge[] = [];
        let edgesWhenCalled: number | null = null;
        inferEmbeddedDatabaseUse({
            databases: [database],
            entries: [{ id: "svc-a", files: ["src/store.ts"] }],
            edges,
            fileText: texts,
            edgeSuffix: "",
            onImporters: () => {
                edgesWhenCalled = edges.length;
            },
        });
        expect(edgesWhenCalled).toBe(0);
        expect(edges).not.toHaveLength(0);
    });
});

describe("inferExternalDelivers", () => {
    const texts = textsOf({
        "src/deliver.ts": 'import { client } from "@langfuse/sdk";',
        "src/self.ts": "const key = process.env.LANGFUSE_API_KEY;",
    });
    const externals = [{ id: "external-langfuse", label: "Langfuse" }];

    it("given an entry that is the external itself or has no files, when inferring, then it is skipped", () => {
        const edges: MapEdge[] = [];
        const entries: NodeIndexEntry[] = [
            { id: "external-langfuse", files: ["src/self.ts"] },
            { id: "svc-empty", files: [] },
            { id: "svc-deliver", files: ["src/deliver.ts"] },
        ];
        inferExternalDelivers({ externals, entries, edges, fileText: texts });
        expect(edges).toEqual([
            {
                id: "svc-deliver--external-langfuse-d",
                from: "svc-deliver",
                to: "external-langfuse",
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.6,
                label: "delivers",
            },
        ]);
    });

    it("given an entry sharing the external's id, when inferring, then no self edge is emitted in either mode", () => {
        const edges: MapEdge[] = [];
        const entries: NodeIndexEntry[] = [{ id: "external-langfuse", files: ["src/self.ts"] }];
        inferExternalDelivers({ externals, entries, edges, fileText: texts });
        expect(edges).toEqual([]);
    });

    it("given a normalised name shorter than four characters, when inferring, then the external is skipped", () => {
        const edges: MapEdge[] = [];
        inferExternalDelivers({
            externals: [{ id: "external-s3", label: "S3" }],
            entries: [{ id: "svc", files: ["src/deliver.ts"] }],
            edges,
            fileText: texts,
        });
        expect(edges).toEqual([]);
    });

    it("given a multi-word external label referenced by SDK import or env prefix, when inferring, then it still delivers", () => {
        const wordy = textsOf({
            "src/imports.ts": 'import OpenAI from "openai";',
            "src/env.ts": "const key = process.env.OPENAI_API_KEY;",
            "src/none.ts": "export const x = 1;",
        });
        // "OpenAI API" must match by its identifying word (openai), not the
        // whole label concatenated to "openaiapi", which matches nothing real.
        const externals = [{ id: "external-openai-api", label: "OpenAI API" }];
        const deliversFrom = (file: string) => {
            const edges: MapEdge[] = [];
            inferExternalDelivers({ externals, entries: [{ id: "svc", files: [file] }], edges, fileText: wordy });
            return edges.map((e) => e.to);
        };
        expect(deliversFrom("src/imports.ts")).toEqual(["external-openai-api"]);
        expect(deliversFrom("src/env.ts")).toEqual(["external-openai-api"]);
        expect(deliversFrom("src/none.ts")).toEqual([]);
    });
});

describe("inferModuleDataFlows", () => {
    const texts = textsOf({
        "src/emit.ts": 'import "@opentelemetry/api";',
        "src/write.ts": "await db.insert(rows);",
        "src/read.ts": "await db.select().from(rows);",
        "src/plain.ts": "export const nothing = 1;",
    });
    const writePattern = /\binsert\(/;
    const readPattern = /\bselect\(/;

    it("given only an OTLP target (deployment 7c-ii), when an entry's source matches, then an unsuffixed export edge is emitted", () => {
        const edges: MapEdge[] = [];
        inferModuleDataFlows({
            entries: [
                { id: "gen", files: ["src/emit.ts"] },
                { id: "quiet", files: ["src/plain.ts"] },
            ],
            edges,
            fileText: texts,
            otlpTargetId: "host-gateway-collector",
        });
        expect(edges).toEqual([
            {
                id: "gen--host-gateway-collector",
                from: "gen",
                to: "host-gateway-collector",
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "OTLP export",
            },
        ]);
    });

    it("given both targets (overview mode), when entries match, then OTLP and database edges interleave per entry", () => {
        const edges: MapEdge[] = [];
        inferModuleDataFlows({
            entries: [
                { id: "mod-a", files: ["src/emit.ts", "src/write.ts"] },
                { id: "mod-b", files: ["src/read.ts"] },
            ],
            edges,
            fileText: texts,
            otlpTargetId: "collector",
            database: { databases: [{ id: "db" }], writePattern, readPattern },
        });
        expect(edges.map((e) => e.id)).toEqual(["mod-a--collector", "mod-a--db-w", "db--mod-b-r"]);
        expect(edges.map((e) => e.label)).toEqual(["OTLP export", "writes", "reads"]);
        expect(edges[1]?.confidence).toBe(0.75);
    });

    it("given several databases, when districts differ, then each entry prefers its district's database, falling back to the first, and never targets itself", () => {
        const edges: MapEdge[] = [];
        const databases = [
            { id: "db-a", districtId: "district-a" },
            { id: "db-b", districtId: "district-b" },
        ];
        inferModuleDataFlows({
            entries: [
                { id: "svc-a", files: ["src/write.ts"], districtId: "district-a" },
                { id: "db-b", files: ["src/write.ts"], districtId: "district-b" },
                { id: "svc-c", files: ["src/write.ts"], districtId: "district-c" },
            ],
            edges,
            fileText: texts,
            database: { databases, writePattern, readPattern },
        });
        expect(edges.map((e) => e.id)).toEqual(["svc-a--db-a-w", "svc-c--db-a-w"]);
    });
});

describe("classifiedVariantServices", () => {
    it("given candidate hosts, when collected, then only image-classified services survive, in candidate then service order", () => {
        const service = (name: string, imageClass?: string): HostService => ({
            name,
            copies: [],
            entryFile: null,
            imageClass,
        });
        const host = (name: string, services: HostService[]): Host => ({
            file: `${name}.yaml`,
            name,
            id: `host-${name}`,
            services,
            rank: 2,
        });
        const dev = host("dev", [service("postgres", "database"), service("app")]);
        const prod = host("prod", [service("redis", "queue")]);
        expect(
            classifiedVariantServices([dev, prod]).map(({ candidate, service: s }) => `${candidate.name}/${s.name}`),
        ).toEqual(["dev/postgres", "prod/redis"]);
    });
});

describe("isEntryPoint", () => {
    const scriptReferencedFiles = new Set(["scripts/redeploy.ts"]);
    const entryDirNames = new Set(["bin", "cli"]);

    it("given a script-referenced file, when classified, then it is an entry in every mode", () => {
        expect(isEntryPoint({ files: ["scripts/redeploy.ts"], scriptReferencedFiles })).toBe(true);
        expect(
            isEntryPoint({
                files: ["scripts/redeploy.ts"],
                scriptReferencedFiles,
                nameArm: { granularity: "child", seg: "helper" },
            }),
        ).toBe(true);
    });

    it("given a module in an entry dir or entry-named (O2), when classified, then only non-support qualifies", () => {
        const base = { files: ["src/cli/run.ts"], scriptReferencedFiles };
        const arm = { granularity: "module" as const, path: "src/cli/run.ts", entryDirNames };
        expect(isEntryPoint({ ...base, nameArm: { ...arm, support: false } })).toBe(true);
        expect(isEntryPoint({ ...base, nameArm: { ...arm, support: true } })).toBe(false);
        expect(
            isEntryPoint({
                files: ["src/delivery-command.ts"],
                scriptReferencedFiles,
                nameArm: {
                    granularity: "module",
                    path: "src/delivery-command.ts",
                    support: false,
                    entryDirNames,
                },
            }),
        ).toBe(true);
    });

    it("given a residual child (M3), when classified, then only a single entry-named loose file qualifies", () => {
        expect(
            isEntryPoint({
                files: ["tools/redeploy-cli.ts"],
                scriptReferencedFiles,
                nameArm: { granularity: "child", seg: "redeploy-cli" },
            }),
        ).toBe(true);
        expect(
            isEntryPoint({
                files: ["tools/a.ts", "tools/b.ts"],
                scriptReferencedFiles,
                nameArm: { granularity: "child", seg: "redeploy-cli" },
            }),
        ).toBe(false);
        expect(
            isEntryPoint({
                files: ["tools/cli/x.ts"],
                scriptReferencedFiles,
                nameArm: { granularity: "child", seg: "cli-helpers" },
            }),
        ).toBe(false);
    });
});
