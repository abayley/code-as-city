// One row of the sidebar's component list: marker index, label, and the
// plain-English type line (or an entry-point badge).

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
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
 * Renders a single component row, scrolling itself into view whenever it
 * becomes the active selection.
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
        <button
            ref={row}
            type="button"
            aria-pressed={selected}
            onClick={onSelect}
            className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none",
                "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                selected && "bg-accent text-accent-foreground",
            )}
        >
            <span className="mt-px w-5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {String(markerIndex + 1).padStart(2, "0")}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
                <span
                    className={cn(
                        "truncate text-xs",
                        landmark ? "font-semibold" : "font-medium",
                        quieter && !selected && "text-muted-foreground",
                    )}
                >
                    {label}
                </span>
                {entryPoint ? (
                    <Badge variant="outline" className="w-fit text-[9px] uppercase tracking-wide">
                        Entry point
                    </Badge>
                ) : (
                    typeLabel && (
                        <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                            {typeLabel}
                        </span>
                    )
                )}
            </span>
        </button>
    );
}
