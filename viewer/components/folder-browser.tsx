// The map-a-folder dialog: browses the server filesystem via /api/browse and
// asks /api/generate for a deployment map or module overview of the folder the
// user settles on.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { CityMap } from "@/lib/city-map";
import { validateCityMap } from "@/lib/city-map";

/** localStorage key holding the folder the browser was last pointed at. */
const LAST_FOLDER_KEY = "code-as-city:last-folder";

/** A directory listing as returned by `/api/browse`. */
type Listing = {
    /** Absolute path of the directory being listed. */
    path: string;
    /** Absolute path of the directory one level up. */
    parent: string;
    /** Immediate subdirectories, in server order. */
    entries: Array<{ name: string; path: string }>;
    /** True when the listed directory is the root of a git repository. */
    isRepo: boolean;
};

/** Props accepted by {@link FolderBrowser}. */
export type FolderBrowserProps = {
    /** Dismisses the dialog (cancel, close button, Escape, or backdrop). */
    onClose: () => void;
    /** Receives the validated map and the path its JSON was written to. */
    onGenerated: (payload: { map: CityMap; jsonPath: string }) => void;
};

/**
 * Splits an absolute path into the breadcrumb segments shown above the folder
 * list, keeping a leading separator entry so root-level paths still read as
 * absolute.
 *
 * @param path - The absolute directory path to break up.
 * @returns The segments in order, outermost first, each with the absolute path
 *   it stands for (unique, so it doubles as the React key).
 */
function pathSegments(path: string): Array<{ label: string; path: string }> {
    const parts = path.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) return [{ label: "/", path: "/" }];
    return parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` }));
}

/**
 * Renders the map-a-folder dialog: a breadcrumb of the current path with a git
 * badge, the clickable directory listing (with a parent row), the module
 * overview choice, the generate action, and any browse or generate error.
 *
 * @param props - See {@link FolderBrowserProps}; the dialog owns its listing,
 *   highlight, overview, busy, and error state and reports nothing else.
 * @returns The dialog element; it is always open while mounted.
 */
export function FolderBrowser({ onClose, onGenerated }: FolderBrowserProps) {
    const [listing, setListing] = useState<Listing | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Roving highlight over the folder list: 0 is "../", entries follow.
    const [highlight, setHighlight] = useState(0);

    /**
     * Fetches a directory listing from the server and resets the highlight,
     * recording any failure for display. The settled folder is remembered so
     * the browser reopens where it last was.
     *
     * @param path - The directory to list; the last-used or server default
     *   when omitted.
     */
    const load = useCallback(async (path?: string) => {
        try {
            const response = await fetch(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            setListing(data);
            setHighlight(0);
            setError(null);
            try {
                localStorage.setItem(LAST_FOLDER_KEY, data.path);
            } catch {
                // Private windows and blocked storage throw; the browser still works.
            }
        } catch (browseError) {
            setError(browseError instanceof Error ? browseError.message : String(browseError));
        }
    }, []);
    useEffect(() => {
        let lastFolder: string | null = null;
        try {
            lastFolder = localStorage.getItem(LAST_FOLDER_KEY);
        } catch {
            // Ignore storage failures and fall back to the server default.
        }
        load(lastFolder ?? undefined);
    }, [load]);

    /**
     * Asks the server to generate a map for the current folder, validates the
     * result, and hands it to the caller; failures surface as inline errors.
     *
     * @param asOverview - True for the module overview, false for the
     *   deployment map.
     */
    async function generate(asOverview: boolean) {
        if (!listing || busy) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/generate", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ repoPath: listing.path, overview: asOverview }),
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            const errors = validateCityMap(data.map);
            if (errors.length) throw new Error(errors.slice(0, 3).join(" "));
            onGenerated(data);
        } catch (generateError) {
            setError(generateError instanceof Error ? generateError.message : String(generateError));
            setBusy(false);
        }
    }
    // The keyboard effect must not re-subscribe on every render, so the current
    // submit closure is held in a ref instead of being a dependency. The ref is
    // written in an effect rather than during render: writing it in the render
    // body is unsafe once rendering can be interrupted or replayed.
    const submitRef = useRef<(asOverview: boolean) => void>(() => {});
    useEffect(() => {
        submitRef.current = (asOverview: boolean) => {
            void generate(asOverview);
        };
    });

    // Keyboard: arrows move the highlight, Enter/Right opens the highlighted
    // folder, Left goes up, typing jumps to the first matching folder
    // (type-ahead, 1s reset), Cmd/Ctrl+Enter generates with the current
    // overview choice, Cmd/Ctrl+Shift+Enter forces the module overview, Esc
    // clears type-ahead then cancels.
    const typeAhead = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const consume = () => {
                event.stopPropagation();
                event.preventDefault();
            };
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                consume();
                submitRef.current(event.shiftKey);
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            // Type-ahead: printable characters accumulate and jump the highlight.
            if (event.key.length === 1 && /[\w.-]/.test(event.key) && listing) {
                consume();
                if (typeAhead.current.timer) clearTimeout(typeAhead.current.timer);
                typeAhead.current.text += event.key.toLowerCase();
                typeAhead.current.timer = setTimeout(() => {
                    typeAhead.current.text = "";
                }, 1000);
                const index = listing.entries.findIndex((entry) =>
                    entry.name.toLowerCase().startsWith(typeAhead.current.text),
                );
                if (index >= 0) setHighlight(index + 1);
                return;
            }
            const rowCount = 1 + (listing?.entries.length ?? 0);
            const open = () => {
                if (!listing) return;
                load(highlight === 0 ? listing.parent : listing.entries[highlight - 1]?.path);
            };
            const handlers: Record<string, () => void> = {
                Escape: () => {
                    if (typeAhead.current.text) {
                        typeAhead.current.text = "";
                        return;
                    }
                    onClose();
                },
                ArrowDown: () => setHighlight((value) => Math.min(rowCount - 1, value + 1)),
                ArrowUp: () => setHighlight((value) => Math.max(0, value - 1)),
                ArrowRight: open,
                Enter: open,
                ArrowLeft: () => {
                    if (listing) load(listing.parent);
                },
            };
            const handler = handlers[event.key];
            if (!handler) return;
            consume();
            handler();
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [highlight, listing, load, onClose]);

    /**
     * Closes the dialog when Base UI reports it dismissed (backdrop click or
     * the close button).
     *
     * @param open - The dialog's requested open state.
     */
    function handleOpenChange(open: boolean) {
        if (!open) onClose();
    }

    return (
        <Dialog open onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Map a folder</DialogTitle>
                    <DialogDescription>
                        Pick a repository on this machine and generate a city map from it.
                    </DialogDescription>
                </DialogHeader>
                {listing && (
                    <FieldGroup>
                        <Field>
                            <div className="flex flex-wrap items-center gap-2">
                                <Breadcrumb>
                                    <BreadcrumbList>
                                        {pathSegments(listing.path).map((segment, index, all) => (
                                            <Fragment key={segment.path}>
                                                <BreadcrumbItem>
                                                    <BreadcrumbPage>{segment.label}</BreadcrumbPage>
                                                </BreadcrumbItem>
                                                {index < all.length - 1 && <BreadcrumbSeparator />}
                                            </Fragment>
                                        ))}
                                    </BreadcrumbList>
                                </Breadcrumb>
                                {listing.isRepo && <Badge variant="secondary">git</Badge>}
                            </div>
                            <ItemGroup className="max-h-96 gap-0 overflow-y-auto">
                                <Item
                                    size="xs"
                                    variant={highlight === 0 ? "outline" : "default"}
                                    render={
                                        <button
                                            type="button"
                                            aria-label="Parent folder"
                                            onClick={() => load(listing.parent)}
                                        />
                                    }
                                >
                                    <ItemContent>
                                        <ItemTitle className="font-mono">../</ItemTitle>
                                    </ItemContent>
                                </Item>
                                {listing.entries.map((entry, index) => (
                                    <Item
                                        key={entry.path}
                                        size="xs"
                                        variant={highlight === index + 1 ? "outline" : "default"}
                                        render={
                                            <button
                                                type="button"
                                                ref={(element) => {
                                                    if (element && highlight === index + 1)
                                                        element.scrollIntoView({ block: "nearest" });
                                                }}
                                                onClick={() => load(entry.path)}
                                            />
                                        }
                                    >
                                        <ItemContent>
                                            <ItemTitle className="font-mono">{entry.name}/</ItemTitle>
                                        </ItemContent>
                                    </Item>
                                ))}
                            </ItemGroup>
                        </Field>
                    </FieldGroup>
                )}
                {error && (
                    <Alert variant="destructive">
                        <AlertTitle>Could not map that folder</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    {busy ? (
                        <Button disabled>
                            <Spinner />
                            Generating…
                        </Button>
                    ) : (
                        <>
                            <Button variant="outline" disabled={!listing} onClick={() => generate(true)}>
                                Module overview <Kbd>⌘⇧↵</Kbd>
                            </Button>
                            <Button disabled={!listing} onClick={() => generate(false)}>
                                Deployment map <Kbd>⌘↵</Kbd>
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
