// The card that follows the pointer over the canvas, summarising whichever
// structure is under the cursor.

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

/** One name/value fact shown under the hovered node's title. */
export type HoverFact = {
    /** Fact label, e.g. "loc" or "modules". */
    name: string;
    /** Already-formatted value. */
    value: string;
};

/** Props accepted by {@link HoverDetails}. */
export type HoverDetailsProps = {
    /** Viewport coordinates to anchor the card to, or null when nothing is hovered. */
    at: { x: number; y: number } | null;
    /** Hovered node's label. */
    title: string;
    /** Up to a few source paths, in display order. */
    paths: readonly string[];
    /** Metrics, room count, type, and tags, in display order. */
    facts: readonly HoverFact[];
};

/**
 * Renders the pointer-following details card. Hover state comes from the 3D
 * scene rather than the DOM, so the card is a controlled HoverCard anchored to
 * a zero-size element parked at the pointer.
 *
 * @param props - See {@link HoverDetailsProps}; the card holds no state.
 * @returns The hover card, open only while `at` is set.
 */
export function HoverDetails({ at, title, paths, facts }: HoverDetailsProps) {
    return (
        <HoverCard open={at !== null} onOpenChange={() => undefined}>
            <HoverCardTrigger
                render={
                    <span
                        aria-hidden="true"
                        className="pointer-events-none fixed size-0"
                        style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
                    />
                }
            />
            <HoverCardContent side="inline-end" align="start">
                <ItemGroup>
                    <Item size="xs">
                        <ItemContent>
                            <ItemTitle>{title}</ItemTitle>
                        </ItemContent>
                    </Item>
                    {paths.map((path) => (
                        <Item key={path} size="xs">
                            <ItemContent>
                                <ItemTitle className="font-mono break-all whitespace-normal">{path}</ItemTitle>
                            </ItemContent>
                        </Item>
                    ))}
                </ItemGroup>
                {facts.length > 0 && (
                    <Table>
                        <TableBody>
                            {facts.map((fact) => (
                                <TableRow key={fact.name}>
                                    <TableCell>{fact.name}</TableCell>
                                    <TableCell className="text-right">{fact.value}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}
