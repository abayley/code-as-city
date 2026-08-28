import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import { useTheme } from "@/lib/theme";

const STORAGE_KEY = "code-as-city:theme";

/**
 * Renders the toggle wired to the real theme hook, as the topbar does, so a
 * test can press it and observe the document and storage effects.
 */
function ThemedToggle() {
    const { theme, toggleTheme } = useTheme();
    return <ThemeToggle theme={theme} onToggle={toggleTheme} />;
}

describe("ThemeToggle with useTheme", () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.classList.remove("dark");
    });

    it("given no stored choice, when the toggle mounts, then the light theme is applied and stored", () => {
        render(<ThemedToggle />);
        expect(document.documentElement).not.toHaveClass("dark");
        expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
        expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
    });

    it("given the light theme, when the toggle is pressed, then the dark class is set and persisted", async () => {
        render(<ThemedToggle />);
        await userEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
        expect(document.documentElement).toHaveClass("dark");
        expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
        expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    });

    it("given the dark theme, when the toggle is pressed again, then the dark class is removed", async () => {
        render(<ThemedToggle />);
        const toggle = screen.getByRole("button");
        await userEvent.click(toggle);
        await userEvent.click(toggle);
        expect(document.documentElement).not.toHaveClass("dark");
        expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
    });

    it("given a stored dark choice, when the toggle mounts, then the dark theme is restored", () => {
        localStorage.setItem(STORAGE_KEY, "dark");
        render(<ThemedToggle />);
        expect(document.documentElement).toHaveClass("dark");
        expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    });

    it("given the light theme, when Cmd+Shift+D is pressed, then the dark theme is applied", () => {
        render(<ThemedToggle />);
        fireEvent.keyDown(window, { key: "d", metaKey: true, shiftKey: true });
        expect(document.documentElement).toHaveClass("dark");
        expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    });

    it("given the light theme, when Ctrl+Shift+D is pressed, then the dark theme is applied", () => {
        render(<ThemedToggle />);
        fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
        expect(document.documentElement).toHaveClass("dark");
    });

    it("given focus is in a text field, when Cmd+Shift+D is pressed, then the theme is left unchanged", () => {
        render(
            <>
                <ThemedToggle />
                <input aria-label="filter" />
            </>,
        );
        const field = screen.getByLabelText("filter");
        field.focus();
        fireEvent.keyDown(field, { key: "d", metaKey: true, shiftKey: true });
        expect(document.documentElement).not.toHaveClass("dark");
    });

    it("given the shortcut has no modifiers, when d is pressed alone, then the theme is left unchanged", () => {
        render(<ThemedToggle />);
        fireEvent.keyDown(window, { key: "d" });
        expect(document.documentElement).not.toHaveClass("dark");
    });
});
