// The viewer's left rail: a search box over the mapped components, grouped
// into always-open district sections.

import { SearchIcon, XIcon } from "lucide-react";
import { ComponentRow, type ComponentRowProps } from "@/components/component-row";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubItem,
    SidebarProvider,
} from "@/components/ui/sidebar";

/** One component row in the rail, keyed by its node id. */
type SidebarRow = Omit<ComponentRowProps, "onSelect"> & {
    /** Node id, used as the React key and passed back on selection. */
    id: string;
};

/** One always-open district section of the rail. */
export type SidebarSection = {
    /** District id, passed back when the header is pressed. */
    id: string;
    /** District name shown in the header. */
    label: string;
    /** Zero-based position; rendered one-based as "N1", "N2", ... */
    index: number;
    /** Band (strip) heading rendered above this section, when it starts one. */
    bandLabel?: string | undefined;
    /** True when this district is the one currently being explored. */
    active: boolean;
    /** Rows surviving the current search filter, in display order. */
    rows: readonly SidebarRow[];
};

/** Props accepted by {@link Sidebar}. */
export type SidebarProps = {
    /** Current search text; the caller owns the state. */
    search: string;
    /** Called with the new search text on every edit and on clear. */
    onSearchChange: (value: string) => void;
    /** Sections to render, already filtered and ordered by the caller. */
    sections: readonly SidebarSection[];
    /** Called with a district id when its header is pressed. */
    onExploreSection: (sectionId: string) => void;
    /** Called with a node id when a component row is pressed. */
    onSelectRow: (nodeId: string) => void;
};

/**
 * Renders the component rail: the InputGroup search with its clear button, and
 * the district sections with their component rows, on the stock Sidebar
 * primitives.
 *
 * The shell is a CSS grid that owns the rail's column, so the stock
 * SidebarProvider wrapper is collapsed with `contents` and the offcanvas
 * `Sidebar` shell is not used; the menu primitives still need the provider's
 * context, which this supplies.
 *
 * @param props - See {@link SidebarProps}; all state lives with the caller and
 *   every interaction is reported through a callback.
 * @returns The rail aside element.
 */
export function Sidebar({ search, onSearchChange, sections, onExploreSection, onSelectRow }: SidebarProps) {
    // Row placement mirrors the retired `.rail` rules: column one under the
    // topbar, spanning both content rows on tablet, hidden on phones.
    return (
        <SidebarProvider className="contents">
            <aside
                aria-label="Mapped components"
                className="row-start-2 flex min-h-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground max-[900px]:row-span-2 max-[680px]:hidden"
            >
                <SidebarHeader>
                    <InputGroup>
                        <InputGroupInput
                            value={search}
                            onChange={(event) => onSearchChange(event.target.value)}
                            placeholder="Find a component"
                            aria-label="Find a component"
                        />
                        <InputGroupAddon>
                            <SearchIcon />
                        </InputGroupAddon>
                        {search && (
                            <InputGroupAddon align="inline-end">
                                <InputGroupButton
                                    size="icon-xs"
                                    aria-label="Clear search"
                                    onClick={() => onSearchChange("")}
                                >
                                    <XIcon />
                                </InputGroupButton>
                            </InputGroupAddon>
                        )}
                    </InputGroup>
                </SidebarHeader>

                <SidebarContent className="themed-scrollbar">
                    {sections.map((section) => (
                        <SidebarGroup key={section.id}>
                            {section.bandLabel !== undefined && (
                                <SidebarGroupLabel className="uppercase">{section.bandLabel}</SidebarGroupLabel>
                            )}
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem>
                                        <SidebarMenuButton
                                            isActive={section.active}
                                            aria-pressed={section.active}
                                            onClick={() => onExploreSection(section.id)}
                                        >
                                            <span className="shrink-0 font-mono tabular-nums">{`D${section.index + 1}`}</span>
                                            <span className="truncate font-medium uppercase">{section.label}</span>
                                        </SidebarMenuButton>
                                        <SidebarMenuSub>
                                            {section.rows.map(({ id, ...row }) => (
                                                <SidebarMenuSubItem key={id}>
                                                    <ComponentRow {...row} onSelect={() => onSelectRow(id)} />
                                                </SidebarMenuSubItem>
                                            ))}
                                        </SidebarMenuSub>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    ))}
                </SidebarContent>
            </aside>
        </SidebarProvider>
    );
}
