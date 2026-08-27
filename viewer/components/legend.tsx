// The key to the map's edge styles, floated over the bottom-right of the
// viewport.

import type { CSSProperties } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { IMPORTS_OUT } from "@/lib/palette";

/**
 * Renders one legend row: the edge's line swatch and its caption.
 *
 * @param props - `swatch` paints the stroke shown in the row's media slot;
 *   `children` is the caption.
 * @returns The legend item.
 */
function LegendItem({ swatch, children }: { swatch: CSSProperties; children: string }) {
    return (
        <Item size="xs">
            <ItemMedia>
                {/* No stock component draws a coloured rule, and the swatch must
                    match the three.js edge colours rather than a theme token. */}
                <span aria-hidden="true" className="inline-block h-0 w-8 border-t-[3px]" style={swatch} />
            </ItemMedia>
            <ItemContent>
                <ItemTitle>{children}</ItemTitle>
            </ItemContent>
        </Item>
    );
}

/**
 * Renders one structure-colour row: a filled swatch and its caption.
 *
 * @param props - `color` fills the swatch; `children` is the caption.
 * @returns The legend item.
 */
function ColorItem({ color, children }: { color: string; children: string }) {
    return (
        <Item size="xs">
            <ItemMedia>
                <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded-[2px]"
                    style={{ backgroundColor: color }}
                />
            </ItemMedia>
            <ItemContent>
                <ItemTitle>{children}</ItemTitle>
            </ItemContent>
        </Item>
    );
}

// The overview's structure colours and what they mean. Only the overview sets a
// node's colour (the deployment map leaves it to the archetype), so these rows
// appear only there — keyed off the colours actually present in the map. Must
// track the OVERVIEW_* constants in assemble-overview.ts.
const STRUCTURE_LEGEND: ReadonlyArray<{ color: string; caption: string }> = [
    { color: "#C77740", caption: "function area" },
    { color: "#C79F40", caption: "shared code" },
    { color: "#A15A34", caption: "UI component" },
    { color: "#283B47", caption: "infrastructure" },
];

/**
 * Renders the edge legend: declared data flow, the selected node's imports,
 * and its importers. Static content, so it takes no props.
 *
 * @returns The legend card.
 */
export function Legend({ structureColors }: { structureColors?: ReadonlySet<string> }) {
    const structures = STRUCTURE_LEGEND.filter((entry) => structureColors?.has(entry.color));
    return (
        <Card size="sm" className="pointer-events-auto absolute right-4 bottom-4 w-fit">
            <CardContent>
                <ItemGroup>
                    {/* Data flow draws in the scene's ink, which vanishes on the dark card, so
                        the swatch tracks the text colour instead. */}
                    <LegendItem swatch={{ borderColor: "currentColor" }}>data flow</LegendItem>
                    <LegendItem swatch={{ borderColor: IMPORTS_OUT }}>what the selected node imports</LegendItem>
                    <LegendItem swatch={{ borderColor: IMPORTS_OUT, borderTopStyle: "dashed" }}>
                        what imports the selected node
                    </LegendItem>
                    {structures.map((entry) => (
                        <ColorItem key={entry.color} color={entry.color}>
                            {entry.caption}
                        </ColorItem>
                    ))}
                </ItemGroup>
            </CardContent>
        </Card>
    );
}
