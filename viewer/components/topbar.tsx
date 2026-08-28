// The viewer's shell chrome: map picker, repository breadcrumb, and actions.
// Shared by the loaded-map viewer and the empty landing shell.

import { ThemeToggle } from "@/components/theme-toggle";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { Showcase } from "@/lib/local-showcases";
import type { Theme } from "@/lib/theme";

/** Props accepted by {@link Topbar}. */
export type TopbarProps = {
    /** Showcases offered by the map picker, in display order. */
    showcases: readonly Showcase[];
    /** Slug of the showcase on screen, or null when none is selected. */
    selectedSlug: string | null;
    /** Picker text shown while no showcase is selected. */
    placeholder: string;
    /** Called with the showcase the user picked. */
    onSelectShowcase: (showcase: Showcase) => void;
    /** Repository name for the breadcrumb; omitted on the empty shell. */
    repoName?: string | undefined;
    /** Repository path shown beside the name when the map carries one. */
    repoPath?: string | undefined;
    /** Opened map file's name; renders a button back into the import flow. */
    mapFilePath?: string | undefined;
    /** Opens the map-file picker (also behind the map-file button). */
    onOpenMap: () => void;
    /** Opens the map-a-folder browser. */
    onMapFolder: () => void;
    /** Active colour theme, passed through to the toggle. */
    theme: Theme;
    /** Flips the colour theme. */
    onToggleTheme: () => void;
};

/**
 * Renders the shell topbar: the showcase Select, the repository breadcrumb
 * with its optional path and map-file button, and the action group (theme
 * toggle, map a folder, open map).
 *
 * @param props - See {@link TopbarProps}; every interaction is reported
 *   through a callback and no state is held here.
 * @returns The topbar header element.
 */
export function Topbar({
    showcases,
    selectedSlug,
    placeholder,
    onSelectShowcase,
    repoName,
    repoPath,
    mapFilePath,
    onOpenMap,
    onMapFolder,
    theme,
    onToggleTheme,
}: TopbarProps) {
    /**
     * Resolves a picked slug to its showcase and reports it upward.
     *
     * @param value - The slug chosen in the Select, or null when cleared.
     * @returns Nothing; an unknown slug is ignored.
     */
    function handleValueChange(value: string | null) {
        const next = showcases.find((candidate) => candidate.slug === value);
        if (next) onSelectShowcase(next);
    }

    // `col-span-full` keeps the bar spanning the shell's grid; it is inert in
    // the empty shell's block layout.
    return (
        <header className="col-span-full z-20 flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-2 text-foreground">
            <Select
                items={showcases.map((candidate) => ({ value: candidate.slug, label: candidate.map.name }))}
                value={selectedSlug}
                onValueChange={handleValueChange}
            >
                <SelectTrigger aria-label="Choose a map" className="min-w-48">
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>
                    {showcases.map((candidate) => (
                        <SelectItem key={candidate.slug} value={candidate.slug}>
                            {candidate.map.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {repoName && (
                <>
                    <Separator orientation="vertical" className="h-5" />
                    <Breadcrumb className="min-w-0">
                        <BreadcrumbList>
                            <BreadcrumbItem>Repository</BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem className="min-w-0">
                                <BreadcrumbPage className="truncate">{repoName}</BreadcrumbPage>
                            </BreadcrumbItem>
                            {repoPath && (
                                <>
                                    <BreadcrumbSeparator />
                                    <BreadcrumbItem className="min-w-0 font-mono">
                                        <span className="truncate">{repoPath}</span>
                                    </BreadcrumbItem>
                                </>
                            )}
                        </BreadcrumbList>
                    </Breadcrumb>
                </>
            )}

            {mapFilePath && (
                <ButtonGroup>
                    <ButtonGroupText>Map file</ButtonGroupText>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onOpenMap}
                        title="Open another map file"
                        className="max-w-64"
                    >
                        <span className="truncate font-mono">{mapFilePath}</span>
                    </Button>
                </ButtonGroup>
            )}

            <ButtonGroup>
                <Button variant="outline" size="sm" onClick={onMapFolder}>
                    Map a folder
                </Button>
                <Button size="sm" onClick={onOpenMap}>
                    Open map
                </Button>
            </ButtonGroup>

            <div className="ml-auto flex items-center gap-2">
                <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            </div>
        </header>
    );
}
