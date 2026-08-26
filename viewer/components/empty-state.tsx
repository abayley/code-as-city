// The landing screen shown before any map is loaded: the two entry actions and
// one card per bundled showcase.

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription } from "@/components/ui/empty";
import type { Showcase } from "@/lib/local-showcases";

/** Props accepted by {@link EmptyState}. */
export type EmptyStateProps = {
    /** Showcases offered as cards, in display order. */
    showcases: readonly Showcase[];
    /** Called with the showcase whose card was clicked. */
    onSelectShowcase: (showcase: Showcase) => void;
    /** Opens the map-file picker. */
    onOpenMap: () => void;
    /** Opens the map-a-folder dialog. */
    onMapFolder: () => void;
};

/**
 * Renders one showcase as a clickable card carrying the map name, its
 * language and shape, and the map summary.
 *
 * @param props - `showcase` is the entry to render; `onSelect` fires when the
 *   card is activated.
 * @returns The card wrapped in its activating button.
 */
function ShowcaseCard({ showcase, onSelect }: { showcase: Showcase; onSelect: () => void }) {
    return (
        <button type="button" onClick={onSelect} className="rounded-lg text-left outline-ring focus-visible:outline-2">
            <Card size="sm" className="h-full">
                <CardHeader>
                    <CardTitle>{showcase.map.name}</CardTitle>
                    <CardDescription>
                        {showcase.language} · {showcase.shape}
                    </CardDescription>
                </CardHeader>
                {showcase.map.summary && (
                    <CardContent>
                        <CardDescription>{showcase.map.summary}</CardDescription>
                    </CardContent>
                )}
            </Card>
        </button>
    );
}

/**
 * Renders the empty state: the open-map and map-a-folder actions, the
 * "or explore a showcase" line, and the showcase card grid.
 *
 * @param props - See {@link EmptyStateProps}; every interaction is reported
 *   through a callback and no state is held here.
 * @returns The empty-state section.
 */
export function EmptyState({ showcases, onSelectShowcase, onOpenMap, onMapFolder }: EmptyStateProps) {
    return (
        <Empty className="mx-auto max-w-5xl gap-6 px-4 py-10">
            <EmptyContent>
                <ButtonGroup>
                    <Button onClick={onOpenMap}>Open map</Button>
                    <Button variant="outline" onClick={onMapFolder}>
                        Map a folder
                    </Button>
                </ButtonGroup>
                <EmptyDescription>or explore a showcase</EmptyDescription>
            </EmptyContent>
            <div className="grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {showcases.map((candidate) => (
                    <ShowcaseCard
                        key={candidate.slug}
                        showcase={candidate}
                        onSelect={() => onSelectShowcase(candidate)}
                    />
                ))}
            </div>
        </Empty>
    );
}
