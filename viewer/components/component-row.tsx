// One row of the sidebar's component list: marker index, label, and the
// plain-English type line (or an entry-point badge).

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** Props accepted by {@link ComponentRow}. */
export type ComponentRowProps = {
    /** Node label shown as the row's title. */
    label: string;
    /** Zero-based marker index; rendered one-based and zero-padded. */
    markerIndex: number;
    /** Plain-English type line, e.g. "System with 4 rooms"; may be empty. */
    typeLabel: string;
    /** True for gateway nodes, which get a badge instead of the type line. */
    entryPoint: boolean;
    /** True when the node contains rooms, giving the label extra weight. */
    landmark: boolean;
    /** True for external nodes, which read quieter than internal ones. */
    quieter: boolean;
    /** True when this row is the current selection. */
    selected: boolean;
    /** Fired when the row is activated. */
    onSelect: () => void;
};

/**
 * Renders a single component row as a stock SidebarMenuButton, scrolling
 * itself into view whenever it becomes the active selection.
 *
 * @param props - See {@link ComponentRowProps}; the row holds no state and
 *   reports activation through `onSelect`.
 * @returns The row button.
 */
export function ComponentRow({
    label,
    markerIndex,
    typeLabel,
    entryPoint,
    landmark,
    quieter,
    selected,
    onSelect,
}: ComponentRowProps) {
    const row = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (selected) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [selected]);

    return (
        <SidebarMenuButton
            size="lg"
            isActive={selected}
            aria-pressed={selected}
            onClick={onSelect}
            render={<button type="button" ref={row} />}
        >
            <span className="shrink-0 font-mono tabular-nums">{String(markerIndex + 1).padStart(2, "0")}</span>
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("truncate", landmark ? "font-semibold" : "font-medium", quieter && "opacity-70")}>
                    {label}
                </span>
                {entryPoint ? (
                    <Badge variant="outline" className="w-fit uppercase">
                        Entry point
                    </Badge>
                ) : (
                    typeLabel && <span className="truncate uppercase opacity-70">{typeLabel}</span>
                )}
            </div>
        </SidebarMenuButton>
    );
}
