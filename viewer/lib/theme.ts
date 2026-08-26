// Theme state for the viewer: Mira's light and dark token sets, applied as
// the `dark` class on the document element (Tailwind's class strategy) and
// remembered across sessions. The scene reads the same state so the map
// background follows the chrome.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "code-as-city:theme";

/**
 * The theme to start in: the remembered choice, else the operating system's
 * preference, else light.
 *
 * @returns The initial theme for this session.
 */
function initialTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Tracks the active theme, applying it to the document element and storing
 * the choice.
 *
 * @returns The active theme and a toggle that flips it.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
    const [theme, setTheme] = useState<Theme>(initialTheme);

    useEffect(() => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        localStorage.setItem(STORAGE_KEY, theme);
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
    }, []);

    return { theme, toggleTheme };
}
