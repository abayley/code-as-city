import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps, type SidebarSection } from "@/components/sidebar";
import { matchesRailSearch } from "@/lib/rail-search";

type Row = SidebarSection["rows"][number];

/**
 * Builds one sidebar row with quiet defaults.
 *
 * @param id - Node id, also used as the row's label suffix.
 * @param label - Row label shown in the rail.
 * @param markerIndex - Zero-based marker index for the row.
 * @returns A row for a {@link SidebarSection}.
 */
function row(id: string, label: string, markerIndex: number): Row {
    return {
        id,
        label,
        markerIndex,
        typeLabel: "Service",
        entryPoint: false,
        landmark: false,
        quieter: false,
        selected: false,
    };
}

const rows: readonly Row[] = [row("checkout", "Checkout API", 0), row("billing", "Billing worker", 1)];

// The searchable node behind each row, as the viewer holds it. The rail
// filters nodes, not rows, so the harness below filters through the same
// predicate the viewer uses rather than restating the rule.
const nodeForRow: Record<string, { label: string; kind: string; description?: string }> = {
    checkout: { label: "Checkout API", kind: "deployable", description: "Takes card payments." },
    billing: { label: "Billing worker", kind: "worker", description: "Issues invoices nightly." },
};

const section: SidebarSection = {
    id: "payments",
    label: "Payments",
    index: 0,
    bandLabel: "Edge",
    active: false,
    rows,
};

/**
 * Renders the rail with the search state and row filtering the real viewer
 * owns, so a test can type into the search box and observe the effect.
 *
 * @param overrides - Props to override on the rendered rail.
 */
function renderRail(overrides: Partial<SidebarProps> = {}): void {
    function Harness() {
        const [search, setSearch] = useState("");
        const visible = rows.filter((candidate) => {
            const node = nodeForRow[candidate.id];
            return node !== undefined && matchesRailSearch(node, search);
        });
        return (
            <Sidebar
                search={search}
                onSearchChange={setSearch}
                sections={[{ ...section, rows: visible }]}
                onExploreSection={() => {}}
                onSelectRow={() => {}}
                {...overrides}
            />
        );
    }
    render(<Harness />);
}

describe("Sidebar", () => {
    it("given rows and a search term, when the term is typed, then only matching rows stay visible", async () => {
        renderRail();
        await userEvent.type(screen.getByLabelText("Find a component"), "billing");
        expect(screen.getByText("Billing worker")).toBeInTheDocument();
        expect(screen.queryByText("Checkout API")).not.toBeInTheDocument();
    });

    it("given a term matching only a node's kind, when it is typed, then that row stays visible", async () => {
        renderRail();
        await userEvent.type(screen.getByLabelText("Find a component"), "deployable");
        expect(screen.getByText("Checkout API")).toBeInTheDocument();
        expect(screen.queryByText("Billing worker")).not.toBeInTheDocument();
    });

    it("given a term matching only a node's description, when it is typed, then that row stays visible", async () => {
        renderRail();
        await userEvent.type(screen.getByLabelText("Find a component"), "invoices");
        expect(screen.getByText("Billing worker")).toBeInTheDocument();
        expect(screen.queryByText("Checkout API")).not.toBeInTheDocument();
    });

    it("given a search term, when the clear button is pressed, then every row returns", async () => {
        renderRail();
        await userEvent.type(screen.getByLabelText("Find a component"), "billing");
        await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect(screen.getByText("Checkout API")).toBeInTheDocument();
        expect(screen.getByText("Billing worker")).toBeInTheDocument();
        expect(screen.getByLabelText("Find a component")).toHaveValue("");
    });

    it("given an empty search, when nothing is typed, then no clear button is offered", () => {
        renderRail();
        expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    });

    it("given a component row, when it is clicked, then onSelectRow fires with the node id", async () => {
        const onSelectRow = vi.fn();
        renderRail({ onSelectRow });
        await userEvent.click(screen.getByRole("button", { name: /Billing worker/ }));
        expect(onSelectRow).toHaveBeenCalledWith("billing");
    });

    it("given a section header, when it is clicked, then onExploreSection fires with the section id", async () => {
        const onExploreSection = vi.fn();
        renderRail({ onExploreSection });
        await userEvent.click(screen.getByRole("button", { name: /PAYMENTS/i }));
        expect(onExploreSection).toHaveBeenCalledWith("payments");
    });

    it("given a section, when the rail renders, then its marker is the district number", () => {
        renderRail();
        expect(screen.getByText("D1")).toBeInTheDocument();
    });

    it("given a section with a band label, when the rail renders, then the band heading is shown", () => {
        renderRail();
        expect(screen.getByText("Edge")).toBeInTheDocument();
    });
});
