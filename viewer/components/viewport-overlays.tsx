// The chrome floating over the 3D canvas: where you are, how to get back,
// what the current view responds to, and the camera-orientation toggle.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";

/** The "you are here" trail shown beside the back button. */
type ViewportBreadcrumb = {
    /** Leading emphasised part, e.g. the map or focused node name. */
    root: string;
    /** Trailing detail, e.g. "1 direct connection". */
    detail: string;
};

/** Props accepted by {@link ViewportOverlays}. */
export type ViewportOverlaysProps = {
    /** True while the camera is in its top-down orientation. */
    overhead: boolean;
    /** Called with the requested orientation when the toggle is pressed. */
    onOverheadChange: (next: boolean) => void;
    /** Steps back to the whole city; null at city level, where the status shows instead. */
    onBack: (() => void) | null;
    /** City-level status line, e.g. "Front → back flow · 8 districts". */
    statusLabel: string;
    /** Trail for the current drill-down, or null at city level. */
    breadcrumb: ViewportBreadcrumb | null;
    /** One-line hint describing what the current view responds to. */
    helpText: string;
};

/**
 * Renders the viewport overlays: the orientation toggle, the location line
 * (back button or city status, plus breadcrumb), and the help line. Each sits
 * on a Card so it stays legible over either the light or the dark canvas.
 *
 * @param props - See {@link ViewportOverlaysProps}; no state is held here and
 *   every interaction is reported through a callback.
 * @returns The overlay layer, which does not intercept pointer events itself.
 */
export function ViewportOverlays({
    overhead,
    onOverheadChange,
    onBack,
    statusLabel,
    breadcrumb,
    helpText,
}: ViewportOverlaysProps) {
    return (
        <div className="pointer-events-none absolute inset-0 z-10">
            <Card size="sm" className="pointer-events-auto absolute top-3 right-4 w-fit">
                <CardContent>
                    <Toggle
                        variant="outline"
                        size="sm"
                        aria-label="Overhead view"
                        pressed={overhead}
                        onPressedChange={onOverheadChange}
                    >
                        {overhead ? "Isometric" : "Overhead"}
                    </Toggle>
                </CardContent>
            </Card>

            <Card size="sm" className="pointer-events-auto absolute top-3 left-4 w-fit max-w-[min(70%,32rem)]">
                <CardContent className="flex flex-wrap items-center gap-2">
                    {onBack ? (
                        <Button variant="outline" size="sm" onClick={onBack}>
                            Back to city
                        </Button>
                    ) : (
                        <CardDescription>{statusLabel}</CardDescription>
                    )}
                    {breadcrumb && (
                        <>
                            <Separator orientation="vertical" className="h-4" />
                            <CardTitle>{breadcrumb.root}</CardTitle>
                            <CardDescription className="min-w-0">{breadcrumb.detail}</CardDescription>
                        </>
                    )}
                </CardContent>
            </Card>

            <Card size="sm" className="pointer-events-auto absolute bottom-4 left-4 w-fit max-[680px]:hidden">
                <CardContent>
                    <CardDescription>{helpText}</CardDescription>
                </CardContent>
            </Card>
        </div>
    );
}
