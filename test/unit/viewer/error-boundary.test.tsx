import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/error-boundary";

/**
 * A component that throws on render, to trip the boundary.
 *
 * @returns Never; it always throws.
 */
function Boom(): never {
    throw new Error("scene exploded");
}

describe("ErrorBoundary", () => {
    beforeEach(() => {
        // React logs the caught error to console.error; silence it so the
        // suite output stays readable.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("given a child that renders cleanly, when mounted, then the child is shown", () => {
        render(
            <ErrorBoundary>
                <p>all good</p>
            </ErrorBoundary>,
        );
        expect(screen.getByText("all good")).toBeInTheDocument();
    });

    it("given a child that throws, when mounted, then a recovery message replaces it", () => {
        render(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>,
        );
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
        expect(screen.getByText(/scene exploded/)).toBeInTheDocument();
    });

    it("given the fallback is shown, when reload is pressed, then the page reloads", async () => {
        const reload = vi.fn();
        vi.spyOn(window, "location", "get").mockReturnValue({
            ...window.location,
            reload,
        } as Location);
        render(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>,
        );
        await userEvent.click(screen.getByRole("button", { name: /reload/i }));
        expect(reload).toHaveBeenCalledOnce();
    });
});
