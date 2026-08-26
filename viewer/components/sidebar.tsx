// The viewer's left rail: a search box over the mapped components, grouped
// into always-open neighbourhood sections.

import { SearchIcon, XIcon } from "lucide-react";
import { ComponentRow, type ComponentRowProps } from "@/components/component-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** One component row in the rail, keyed by its node id. */
type SidebarRow = Omit<ComponentRowProps, "onSelect"> & {
    /** Node id, used as the React key and passed back on selection. */
    id: string;
};

/** One always-open neighbourhood section of the rail. */
export type SidebarSection = {
    /** Neighbourhood id, passed back when the header is pressed. */
    id: string;
    /** Neighbourhood name shown in the header. */
    label: string;
    /** Zero-based position; rendered one-based as "N1", "N2", ... */
    index: number;
    /** Band (strip) heading rendered above this section, when it starts one. */
    bandLabel?: string | undefined;
    /** District accent colour, drawn as the section's left edge. */
    accent: string;
    /** True when this neighbourhood is the one currently being explored. */
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
    /** Called with a neighbourhood id when its header is pressed. */
    onExploreSection: (sectionId: string) => void;
    /** Called with a node id when a component row is pressed. */
    onSelectRow: (nodeId: string) => void;
};

/**
 * Renders the component rail: the search Input with its clear button, and the
 * neighbourhood sections with their component rows.
 *
 * @param props - See {@link SidebarProps}; all state lives with the caller and
 *   every interaction is reported through a callback.
 * @returns The rail aside element.
 */
export function Sidebar({ search, onSearchChange, sections, onExploreSection, onSelectRow }: SidebarProps) {
    // Row placement mirrors the retired `.rail` rules: column one under the
    // topbar, spanning both content rows on tablet, hidden on phones.
    return (
        <aside className="row-start-2 overflow-y-auto border-r border-border bg-sidebar px-3 py-4 text-sidebar-foreground max-[900px]:row-span-2 max-[680px]:hidden">
            <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={search}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="Find a component"
                    aria-label="Find a component"
                    className="h-8 pr-8 pl-7"
                />
                {search && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Clear search"
                        onClick={() => onSearchChange("")}
                        className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
                    >
                        <XIcon className="size-3.5" />
                    </Button>
                )}
            </div>

            <nav aria-label="Mapped components" className="mt-4 flex flex-col gap-4">
                {sections.map((section) => (
                    <section key={section.id}>
                        {section.bandLabel !== undefined && (
                            <p className="mb-2 bg-foreground px-2 py-1.5 text-[10px] tracking-[0.16em] text-background uppercase">
                                {section.bandLabel}
                            </p>
                        )}
                        <div className="border-l-2 pl-2" style={{ borderColor: section.accent }}>
                            <button
                                type="button"
                                aria-pressed={section.active}
                                onClick={() => onExploreSection(section.id)}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            >
                                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                                    {`N${section.index + 1}`}
                                </span>
                                <strong className="truncate text-[11px] font-semibold tracking-wide uppercase">
                                    {section.label}
                                </strong>
                            </button>
                            <div className="mt-1 flex flex-col">
                                {section.rows.map(({ id, ...row }) => (
                                    <ComponentRow key={id} {...row} onSelect={() => onSelectRow(id)} />
                                ))}
                            </div>
                        </div>
                    </section>
                ))}
            </nav>
        </aside>
    );
}
