import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import type { CityMap } from "@/lib/city-map";
import type { Showcase } from "@/lib/showcase-maps";

/**
 * Builds a minimal showcase whose map carries only the fields the empty state
 * reads.
 *
 * @param slug - Showcase slug, also used as the map id.
 * @param name - Map name shown as the card title.
 * @param summary - Map summary shown in the card body; omit for none.
 * @returns A showcase suitable for {@link EmptyState}.
 */
function showcase(slug: string, name: string, summary?: string): Showcase {
    const map: CityMap = { schemaVersion: 1, id: slug, name, nodes: [], edges: [] };
    return {
        slug,
        map: summary === undefined ? map : { ...map, summary },
        language: "TypeScript",
        shape: "Module overview",
        accent: "#376f71",
    };
}

const showcases = [showcase("react", "React", "The rendering library."), showcase("redis", "Redis")];

describe("EmptyState", () => {
    it("given showcases, when the empty state renders, then one card per showcase is shown", () => {
        render(
            <EmptyState
                showcases={showcases}
                onSelectShowcase={() => {}}
                onOpenMap={() => {}}
                onMapFolder={() => {}}
            />,
        );
        const reactCard = screen.getByRole("button", { name: /React/ });
        expect(within(reactCard).getByText("The rendering library.")).toBeInTheDocument();
        expect(within(reactCard).getByText("TypeScript · Module overview")).toBeInTheDocument();
        const redisCard = screen.getByRole("button", { name: /Redis/ });
        expect(within(redisCard).queryByText("The rendering library.")).not.toBeInTheDocument();
    });

    it("given a showcase card, when it is clicked, then onSelectShowcase fires with that showcase", async () => {
        const onSelectShowcase = vi.fn();
        render(
            <EmptyState
                showcases={showcases}
                onSelectShowcase={onSelectShowcase}
                onOpenMap={() => {}}
                onMapFolder={() => {}}
            />,
        );
        await userEvent.click(screen.getByRole("button", { name: /Redis/ }));
        expect(onSelectShowcase).toHaveBeenCalledWith(showcases[1]);
    });

    it("given the action buttons, when each is pressed, then its own callback fires", async () => {
        const onOpenMap = vi.fn();
        const onMapFolder = vi.fn();
        render(
            <EmptyState
                showcases={showcases}
                onSelectShowcase={() => {}}
                onOpenMap={onOpenMap}
                onMapFolder={onMapFolder}
            />,
        );
        await userEvent.click(screen.getByRole("button", { name: "Open map" }));
        await userEvent.click(screen.getByRole("button", { name: "Map a folder" }));
        expect(onOpenMap).toHaveBeenCalledTimes(1);
        expect(onMapFolder).toHaveBeenCalledTimes(1);
    });
});
