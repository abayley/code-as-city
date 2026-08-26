// The viewer's right-hand panel: either the map's own summary and contents
// (when nothing is hovered or selected) or the focused node's description,
// source files, and stats.

import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

/** One name/value row of a stats or contents table. */
export type InspectorStat = {
    /** Row label, e.g. "loc" or "external systems". */
    name: string;
    /** Already-formatted value, e.g. "412" or "83%". */
    value: string;
};

/** One entry of the inspector's source-file list. */
export type InspectorSource = {
    /** React key; unique within the list. */
    key: string;
    /** Path (with optional `:line`) shown as the row's body. */
    label: string;
    /** Attribute name shown as a leading tag, when the row came from one. */
    tag?: string | undefined;
    /** Resolved deep link into the repository, when one exists. */
    href?: string | undefined;
};

/** What the inspector should display, chosen by the caller. */
export type InspectorContent =
    | {
          /** The map summary, shown when nothing is hovered or selected. */
          kind: "map";
          /** Map name. */
          title: string;
          /** Summary and generation paragraphs, in display order. */
          paragraphs: readonly string[];
          /** Node/edge counts by category, already filtered and formatted. */
          contents: readonly InspectorStat[];
      }
    | {
          /** A single node's details. */
          kind: "node";
          /** Node id; remounts the panel when the focused node changes. */
          nodeId: string;
          /** Node label. */
          title: string;
          /** Plain-English type line, e.g. "System with 4 rooms"; may be empty. */
          typeLabel: string;
          /** Description paragraphs; never empty (the caller supplies a fallback). */
          paragraphs: readonly string[];
          /** Source files and attribute paths, in display order. */
          sources: readonly InspectorSource[];
          /** Metric rows that carry a value, in display order. */
          stats: readonly InspectorStat[];
      };

/** Props accepted by {@link Inspector}. */
export type InspectorProps = {
    /** The panel's current content; see {@link InspectorContent}. */
    content: InspectorContent;
};

/**
 * Renders a titled card wrapping a two-column table of name/value rows.
 *
 * @param props - `title` heads the card; `rows` are the entries to list.
 * @returns The stats card, or null when there is nothing to show.
 */
function StatTable({ title, rows }: { title: string; rows: readonly InspectorStat[] }) {
    if (rows.length === 0) return null;
    return (
        <Card size="sm">
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.name}>
                                <TableCell>{row.name}</TableCell>
                                <TableCell className="text-right tabular-nums">{row.value}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}

/**
 * Renders one source-file row: a new-tab link when the path resolved to a
 * URL, plain text otherwise.
 *
 * @param props - `source` is the row to render; see {@link InspectorSource}.
 * @returns The item row.
 */
function SourceItem({ source }: { source: InspectorSource }) {
    const body = (
        <>
            {source.tag && (
                <ItemMedia>
                    <Badge variant="outline">{source.tag}</Badge>
                </ItemMedia>
            )}
            <ItemContent>
                <ItemTitle className="font-mono">{source.label}</ItemTitle>
            </ItemContent>
            {source.href && (
                <ItemActions>
                    <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                </ItemActions>
            )}
        </>
    );
    return source.href ? (
        <Item
            variant="outline"
            size="xs"
            render={
                <a href={source.href} target="_blank" rel="noreferrer" aria-label={`Open ${source.label} in source`}>
                    {body}
                </a>
            }
        />
    ) : (
        <Item variant="outline" size="xs">
            {body}
        </Item>
    );
}

/**
 * Renders the inspector panel for the current content: the map summary with
 * its contents table, or a node's type, description, source files, and stats.
 *
 * @param props - See {@link InspectorProps}; the panel holds no state.
 * @returns The inspector aside element.
 */
export function Inspector({ content }: InspectorProps) {
    // Row placement mirrors the retired `.inspector` rules: column three under
    // the topbar, dropping below the viewport at tablet widths.
    return (
        <aside
            aria-label="Details"
            className="col-start-3 row-start-2 overflow-y-auto border-l border-border bg-sidebar px-4 py-5 max-[900px]:col-start-2 max-[900px]:row-start-3 max-[900px]:border-t max-[900px]:border-l-0"
        >
            {content.kind === "map" ? (
                <div key="map-summary" className="flex flex-col gap-4">
                    <Card size="sm">
                        <CardHeader>
                            <CardDescription>This map</CardDescription>
                            <CardTitle>{content.title}</CardTitle>
                        </CardHeader>
                        {content.paragraphs.length > 0 && (
                            <CardContent className="flex flex-col gap-2">
                                {content.paragraphs.map((paragraph) => (
                                    <CardDescription key={paragraph}>{paragraph}</CardDescription>
                                ))}
                            </CardContent>
                        )}
                    </Card>
                    <StatTable title="Contents" rows={content.contents} />
                </div>
            ) : (
                <div key={content.nodeId} className="flex flex-col gap-4">
                    <Card size="sm">
                        <CardHeader>
                            <CardDescription>What it does</CardDescription>
                            <CardTitle>{content.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2">
                            {content.typeLabel && <Badge variant="outline">{content.typeLabel}</Badge>}
                            {content.paragraphs.map((paragraph) => (
                                <CardDescription key={paragraph}>{paragraph}</CardDescription>
                            ))}
                        </CardContent>
                    </Card>
                    {content.sources.length > 0 && (
                        <Card size="sm">
                            <CardHeader>
                                <CardTitle>Source files</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ItemGroup>
                                    {content.sources.map((source) => (
                                        <SourceItem key={source.key} source={source} />
                                    ))}
                                </ItemGroup>
                            </CardContent>
                        </Card>
                    )}
                    <StatTable title="Stats" rows={content.stats} />
                </div>
            )}
        </aside>
    );
}
