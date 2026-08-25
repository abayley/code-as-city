// The emitted city-map vocabulary shared by both assembly pipelines and emit.
// Field-for-field this matches vendor/functionary's schema (plus the
// generator-internal FileEdge); the viewer keeps its own copy in
// viewer/lib/city-map.ts by design (vendored upstream code).

export type FileEdge = { from: string; to: string };

export type SourceRef = { path: string };

type NodeDisplay = {
    color?: string | undefined;
    flowLayer?: number | undefined;
    flowOrder?: number | undefined;
    size?: [number, number, number] | undefined;
};

type NodeMetrics = {
    loc?: number | undefined;
    complexity?: number | undefined;
    files?: number | undefined;
    coverage?: number | undefined;
};

export type MapNode = {
    id: string;
    label: string;
    kind: string;
    archetype: string;
    parentId?: string | undefined;
    description?: string | undefined;
    attributes?: Record<string, string> | undefined;
    sourceRefs?: SourceRef[] | undefined;
    metrics?: NodeMetrics | undefined;
    tags?: string[] | undefined;
    display?: NodeDisplay | undefined;
};

export type MapEdge = {
    id: string;
    from: string;
    to: string;
    kind: string;
    evidence: string;
    confidence?: number | undefined;
    label?: string | undefined;
    sourceRefs?: SourceRef[] | undefined;
};
