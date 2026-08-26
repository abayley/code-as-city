import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComponentRow, type ComponentRowProps } from "@/components/component-row";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * Builds row props with quiet defaults so each test states only the fields it
 * cares about.
 *
 * @param overrides - Fields to change for this test.
 * @returns Complete props for {@link ComponentRow}.
 */
function rowProps(overrides: Partial<ComponentRowProps> = {}): ComponentRowProps {
    return {
        label: "Checkout API",
        markerIndex: 0,
        typeLabel: "System with 4 rooms",
        entryPoint: false,
        landmark: false,
        quieter: false,
        selected: false,
        onSelect: () => {},
        ...overrides,
    };
}

/**
 * Renders a component row inside the SidebarProvider its stock menu button
 * requires, and returns nothing beyond Testing Library's usual queries.
 *
 * @param props - Props for the row under test.
 */
function renderRow(props: ComponentRowProps): void {
    render(
        <SidebarProvider>
            <ComponentRow {...props} />
        </SidebarProvider>,
    );
}

describe("ComponentRow", () => {
    it("given a row, when it renders, then the label, marker index and type line are shown", () => {
        renderRow(rowProps({ markerIndex: 4 }));
        const row = screen.getByRole("button");
        expect(row).toHaveTextContent("Checkout API");
        expect(row).toHaveTextContent("05");
        expect(row).toHaveTextContent("System with 4 rooms");
    });

    it("given an entry point, when it renders, then the entry-point badge replaces the type line", () => {
        renderRow(rowProps({ entryPoint: true }));
        const row = screen.getByRole("button");
        expect(row).toHaveTextContent("Entry point");
        expect(row).not.toHaveTextContent("System with 4 rooms");
    });

    it("given a row, when it is clicked, then onSelect fires once", async () => {
        const onSelect = vi.fn();
        renderRow(rowProps({ onSelect }));
        await userEvent.click(screen.getByRole("button"));
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("given the selected row, when it renders, then it reports itself as pressed", () => {
        renderRow(rowProps({ selected: true }));
        expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    });
});
