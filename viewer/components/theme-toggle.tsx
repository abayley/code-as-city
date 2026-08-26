// Topbar control flipping the viewer between Mira's light and dark themes.

import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/lib/theme";

/**
 * Renders the light/dark toggle.
 *
 * @param props - `theme`: the active theme, deciding which icon and label to
 *   show; `onToggle`: invoked when the control is pressed.
 * @returns An icon button that flips the theme.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
    const nextTheme = theme === "dark" ? "light" : "dark";
    return (
        <Button variant="ghost" size="icon" onClick={onToggle} aria-label={`Switch to ${nextTheme} theme`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>
    );
}
