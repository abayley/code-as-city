// The shared inference passes both assembly pipelines apply (HEURISTICS.md
// M1/M8/M10/D13 shared with O8/O11). Each pass works over NodeIndexEntry
// records built per-mode: the deployment map from classificationSets and
// fileNodeOwner, the overview from allModules. The caller supplies the
// records in its own iteration order, so each mode's original edge order is
// replayed exactly; genuine divergences (edge id suffixes, guard asymmetries,
// target selection) surface as options.

import { sep } from "node:path";
import {
    addEdge,
    externalReferencePattern,
    fileModuleName,
    sdkImporterIds,
    sdkImportPattern,
} from "./assembly-helpers.ts";
import type { Host, HostService } from "./hosts.ts";
import { ENTRY_FILE_PATTERN } from "./inventory.ts";
import type { MapEdge } from "./map-types.ts";
import type { EmbeddedDatabase, ExternalServiceDep } from "./scans.ts";
import { ENDPOINT_ENV_OVERRIDES, externalNodeId, OTLP_PATTERN } from "./scans.ts";
import { stripJsComments } from "./text.ts";

/** The node-shaped record the shared inference passes consume. */
export type NodeIndexEntry = {
    id: string;
    files: readonly string[];
    districtId?: string | undefined;
    entryFile?: string | null | undefined;
};

/**
 * D13/O11: entries importing an embedded database's SDK read/write that
 * database. The caller controls importer discovery order by the order (and
 * granularity) of its entries — the deployment map passes one entry per
 * owned source file, the overview one per module — and duplicate entry ids
 * collapse to the first match. `onImporters` runs before the edges are
 * emitted, letting the deployment map create the database node parented into
 * its importers' district; the overview creates its node elsewhere and emits
 * "-u"-suffixed edge ids where the deployment map uses none.
 *
 * @param options - The pass inputs: `databases` — the embedded databases
 *   from the D13 scan; `entries` — the node-shaped records to test, in the
 *   mode's own order; `edges` — the accumulating edge list, mutated in
 *   place; `fileText` — reads a repo-relative file's text; `edgeSuffix` —
 *   appended to each edge id ("" for the deployment map, "-u" for the
 *   overview); `onImporters` — optional callback run per database with its
 *   importer ids before the edges are emitted.
 */
export function inferEmbeddedDatabaseUse(options: {
    databases: readonly EmbeddedDatabase[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    edgeSuffix: string;
    onImporters?: ((database: EmbeddedDatabase, importerIds: readonly string[]) => void) | undefined;
}): void {
    for (const database of options.databases) {
        const importPattern = sdkImportPattern(database.depName);
        const importerIds: string[] = [];
        for (const entry of options.entries) {
            if (!entry.files.some((file) => importPattern.test(options.fileText(file)))) continue;
            if (!importerIds.includes(entry.id)) importerIds.push(entry.id);
        }
        options.onImporters?.(database, importerIds);
        for (const importer of importerIds) {
            addEdge(options.edges, {
                id: `${importer}--${database.id}${options.edgeSuffix}`,
                from: importer,
                to: database.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "reads/writes",
                sourceRefs: [{ path: database.path }],
            });
        }
    }
}

/**
 * D17 endpoint resolution (HC-019): resolves a service's identity against its
 * importers' source. When an importer references an env var that redirects
 * the SDK's base URL to a different backend, the service takes that backend's
 * identity (id, label, description) before any node or edge names it — the
 * `openai` SDK configured through `OLLAMA_BASE_URL` is an Ollama server. A
 * service already labelled as the target, or with no matching env reference,
 * resolves to itself.
 *
 * @param options - `service` the detected client-SDK service; `importerFiles`
 *   the files of every entry importing the SDK; `fileText` reads a
 *   repo-relative file's text.
 * @returns The resolved service identity (a copy when overridden).
 */
function resolveServiceEndpoint(options: {
    service: ExternalServiceDep;
    importerFiles: readonly string[];
    fileText: (file: string) => string;
}): ExternalServiceDep {
    const { service, importerFiles, fileText } = options;
    for (const override of ENDPOINT_ENV_OVERRIDES) {
        // Identity by node id, not display label: the label is prose, the id
        // is the node the pass addresses.
        const resolvedId = externalNodeId(override.label);
        if (resolvedId === service.id) continue;
        if (!service.depNames.some((dep) => override.deps.includes(dep))) continue;
        // A reference in a comment is not a configuration: resolve against the
        // comment-stripped text (HC-019; the guard M6's window gives config
        // files, adapted to source).
        if (!importerFiles.some((file) => override.pattern.test(stripJsComments(fileText(file))))) continue;
        return {
            ...service,
            id: resolvedId,
            label: override.label,
            description: `External service (${override.label}) — endpoint resolved from the ${service.label} SDK's configuration declared in ${service.path}.`,
        };
    }
    return service;
}

/**
 * D17: a client-SDK dependency naming an external service becomes one external
 * node per service, with an inferred `data_flow` "uses" edge (confidence 0.7)
 * from every entry whose source imports the SDK. Drawn only when an entry
 * actually imports it, so a bare dependency draws nothing — hence a service
 * with no importers fires neither the callback nor an edge. `onImporters` runs
 * before the edges are emitted, letting the deployment map create the external
 * node parented into its externals district and the overview create its infra
 * member elsewhere; the overview emits "-u"-suffixed edge ids where the
 * deployment map uses none. The service resolves through the endpoint-override
 * table (HC-019) before the callback, so both modes name the resolved backend.
 *
 * @param options - The pass inputs: `services` — the client-SDK services from
 *   the D17 scan; `entries` — the node-shaped records to test, in the mode's
 *   own order; `edges` — the accumulating edge list, mutated in place;
 *   `fileText` — reads a repo-relative file's text; `edgeSuffix` — appended to
 *   each edge id ("" for the deployment map, "-u" for the overview);
 *   `onImporters` — optional callback run per drawn service with its importer
 *   ids before the edges are emitted (not run for a service with no importers).
 */
export function inferExternalServiceUse(options: {
    services: readonly ExternalServiceDep[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    edgeSuffix: string;
    onImporters?: ((service: ExternalServiceDep, importerIds: readonly string[]) => void) | undefined;
}): void {
    // Resolve each detected service against its own importers first, then fold
    // the ones whose resolved identity collides (HC-019: an `openai` SDK
    // pointed at OLLAMA_BASE_URL and an `ollama` SDK are one backend). The
    // fold unions dep names, and importers are re-discovered over the union so
    // every SDK's importers reach the one node.
    const folded = new Map<string, ExternalServiceDep>();
    for (const service of options.services) {
        const importerIds = sdkImporterIds(service.depNames, options.entries, options.fileText);
        if (importerIds.length === 0) continue;
        // The index carries one entry per owned file, several sharing a node
        // id — collect the files of every entry the importers name, not just
        // the first entry per id.
        const importerIdSet = new Set(importerIds);
        const importerFiles = options.entries
            .filter((entry) => importerIdSet.has(entry.id))
            .flatMap((entry) => entry.files);
        const resolved = resolveServiceEndpoint({ service, importerFiles, fileText: options.fileText });
        const existing = folded.get(resolved.id);
        if (existing === undefined) {
            folded.set(resolved.id, resolved);
            continue;
        }
        folded.set(resolved.id, {
            ...existing,
            depNames: [...existing.depNames, ...resolved.depNames.filter((d) => !existing.depNames.includes(d))],
        });
    }
    for (const service of folded.values()) {
        const importerIds = sdkImporterIds(service.depNames, options.entries, options.fileText);
        options.onImporters?.(service, importerIds);
        for (const importer of importerIds) {
            addEdge(options.edges, {
                id: `${importer}--${service.id}${options.edgeSuffix}`,
                from: importer,
                to: service.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "uses",
                sourceRefs: [{ path: service.path }],
            });
        }
    }
}

/**
 * M10/O8: entries referencing an external system by SDK import or env-var
 * prefix deliver data to it. Entries that are the external itself or carry
 * no files are skipped in both modes. Two precision guards (HC-024): an
 * entry whose files are ALL script-reachable (build tooling, not the running
 * system) is skipped when the caller passes `scriptFiles`; and an entry the
 * D17 pass already connected to the external draws no second edge.
 *
 * @param options - The pass inputs: `externals` — the external-system nodes
 *   (M6/D11/D12), matched by their label's identifying first word; `entries` —
 *   the node-shaped records to test; `edges` — the accumulating edge list,
 *   mutated in place; `fileText` — reads a repo-relative file's text;
 *   `scriptFiles` — the script-reachable file set (R1); an entry whose files
 *   all sit in it draws nothing.
 */
export function inferExternalDelivers(options: {
    externals: readonly { id: string; label: string }[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    scriptFiles?: ReadonlySet<string> | undefined;
}): void {
    for (const external of options.externals) {
        // Match on the label's identifying FIRST word, not the whole label
        // concatenated: "OpenAI API" -> "openai" (matching `from "openai"` and
        // the OPENAI_ env prefix), not "openaiapi", which matches nothing real.
        // "IMAP mail server" -> "imap", "Langfuse" -> "langfuse".
        const name = (external.label.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (name.length < 4) continue;
        const referencePattern = externalReferencePattern(name);
        for (const entry of options.entries) {
            if (entry.id === external.id || !entry.files.length) continue;
            // HC-024: build scripts reference endpoints without shipping data.
            if (options.scriptFiles !== undefined && entry.files.every((f) => options.scriptFiles?.has(f))) continue;
            // HC-024: the D17 pass already drew this relationship ("uses");
            // a second inferred edge for the same pair is double-drawing.
            if (options.edges.some((edge) => edge.from === entry.id && edge.to === external.id)) continue;
            if (!entry.files.some((file) => referencePattern.test(options.fileText(file)))) continue;
            addEdge(options.edges, {
                id: `${entry.id}--${external.id}-d`,
                from: entry.id,
                to: external.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.6,
                label: "delivers",
            });
        }
    }
}

/**
 * M1/M8 shared with O8: per-entry data-flow inference — OTLP producers into
 * the collector, and database writes/reads. The two sub-inferences live in
 * one pass because the overview interleaves them per module (its edge order
 * depends on it); the deployment map calls the pass twice, once per universe
 * (OTLP over promoted nodes, database flow over classification sets).
 * Collector selection stays per-mode; database targeting is shared — the
 * entry's district-local database wins, else the first declared.
 *
 * @param options - The pass inputs: `entries` — the node-shaped records to
 *   test, in the mode's own order; `edges` — the accumulating edge list,
 *   mutated in place; `fileText` — reads a repo-relative file's text;
 *   `otlpTargetId` — the collector node OTLP producers export to (omit to
 *   skip the M1 arm); `database` — the database nodes plus the SQL/ORM
 *   write and read patterns (omit to skip the M8 arm).
 */
export function inferModuleDataFlows(options: {
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    otlpTargetId?: string | undefined;
    database?:
        | {
              databases: readonly { id: string; districtId?: string | undefined }[];
              writePattern: RegExp;
              readPattern: RegExp;
              /** HC-024: a module must also reference a db client (SDK import, pool) for its SQL forms to count. */
              clientPattern?: RegExp | undefined;
          }
        | undefined;
}): void {
    for (const entry of options.entries) {
        const texts = entry.files.map((file) => options.fileText(file));
        const otlpTargetId = options.otlpTargetId;
        if (otlpTargetId !== undefined && texts.some((text) => OTLP_PATTERN.test(text))) {
            addEdge(options.edges, {
                id: `${entry.id}--${otlpTargetId}`,
                from: entry.id,
                to: otlpTargetId,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "OTLP export",
            });
        }
        const database = options.database;
        if (!database) continue;
        // HC-024: a browser-only module (every file .tsx/.jsx) cannot open a
        // SQL connection — a write/read pattern match there is a string
        // literal in component code, not a query. And without a database
        // client reference anywhere in the module, a pattern match is a
        // string literal too.
        const browserOnly =
            entry.files.length > 0 && entry.files.every((f) => f.endsWith(".tsx") || f.endsWith(".jsx"));
        const hasClient =
            database.clientPattern === undefined ||
            entry.files.some((f) => database.clientPattern?.test(options.fileText(f)));
        if (browserOnly || !hasClient) continue;
        const target = (database.databases.find((db) => db.districtId === entry.districtId) ?? database.databases[0])
            ?.id;
        if (target === undefined || target === entry.id) continue;
        if (texts.some((text) => database.writePattern.test(text))) {
            addEdge(options.edges, {
                id: `${entry.id}--${target}-w`,
                from: entry.id,
                to: target,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.75,
                label: "writes",
            });
        }
        if (texts.some((text) => database.readPattern.test(text))) {
            addEdge(options.edges, {
                id: `${target}--${entry.id}-r`,
                from: target,
                to: entry.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.75,
                label: "reads",
            });
        }
    }
}

/**
 * D1/D6/O7 shared record source: the image-classified services declared
 * across compose variants, in candidate-host then service order. The gating
 * stays per-mode by decision (the modes' conditions genuinely differ): the
 * deployment map keeps the first service per name for depends_on backfill;
 * the overview keeps non-built store-class services and attributes them to
 * the surviving host sharing the variant's service names.
 *
 * @param candidateHosts - Every compose-variant host, including deduped
 *   environment variants.
 * @returns Each image-classified service paired with the variant declaring
 *   it, in candidate-host then service order.
 */
export function classifiedVariantServices(
    candidateHosts: readonly Host[],
): { candidate: Host; service: HostService }[] {
    const classified: { candidate: Host; service: HostService }[] = [];
    for (const candidate of candidateHosts) {
        for (const service of candidate.services) {
            if (service.imageClass !== undefined) classified.push({ candidate, service });
        }
    }
    return classified;
}

/**
 * M3/O2 entry classification, one function with the per-granularity arms
 * explicit. A file referenced from a package.json script is a DECLARED entry
 * in every mode. Name-based arms differ by documented rule: the overview's
 * modules (O2) also qualify via an entry-dir path segment or an entry-named
 * file, but only when not imported (support modules are plumbing); the
 * deployment map's residual children (M3) qualify only as a single
 * entry-named loose file.
 *
 * @param options - The classification inputs: `files` — the node's files;
 *   `scriptReferencedFiles` — files named directly by package.json script
 *   commands (R1's script roots); `nameArm` — the optional name-based arm:
 *   for overview modules, the module path, its imported/support status, and
 *   the entry-dir name set; for deployment residual children, the child's
 *   path segment.
 * @returns Whether the node classifies as a gateway (entry point).
 */
export function isEntryPoint(options: {
    files: readonly string[];
    scriptReferencedFiles: ReadonlySet<string>;
    nameArm?:
        | { granularity: "module"; path: string; support: boolean; entryDirNames: ReadonlySet<string> }
        | { granularity: "child"; seg: string }
        | undefined;
}): boolean {
    if (options.files.some((file) => options.scriptReferencedFiles.has(file))) return true;
    const arm = options.nameArm;
    if (arm === undefined) return false;
    if (arm.granularity === "module") {
        return (
            !arm.support &&
            (arm.path.split(sep).some((seg) => arm.entryDirNames.has(seg)) ||
                ENTRY_FILE_PATTERN.test(fileModuleName(arm.path)))
        );
    }
    return options.files.length === 1 && ENTRY_FILE_PATTERN.test(arm.seg);
}
