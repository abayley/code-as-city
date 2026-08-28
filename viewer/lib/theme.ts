// Theme state for the viewer: Mira's light and dark token sets, applied as
// the `dark` class on the document element (Tailwind's class strategy) and
// remembered across sessions. The scene reads the same state so the map
// background follows the chrome.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "code-as-city:theme";

/**
 * Whether an event originated from a text-editing target, where a bare-letter
 * shortcut would swallow the user's typing.
 *
 * @param target - The event target to test.
 * @returns True when the target is an input, textarea, select, or a
 *   contenteditable node.
 */
function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

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

    // Cmd/Ctrl+Shift+D flips the theme from the keyboard, ignoring text-editing
    // targets so it never swallows typed input.
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
            if (event.key.toLowerCase() !== "d") return;
            if (isEditableTarget(event.target)) return;
            event.preventDefault();
            toggleTheme();
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [toggleTheme]);

    return { theme, toggleTheme };
}
