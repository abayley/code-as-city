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
 * Renders the edge legend: declared data flow, the selected node's imports,
 * and its importers. Static content, so it takes no props.
 *
 * @returns The legend card.
 */
export function Legend() {
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
                </ItemGroup>
            </CardContent>
        </Card>
    );
}
