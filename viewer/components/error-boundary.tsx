// App-level error boundary: the WebGL scene and map assembly can throw on
// malformed data or a lost GL context, so a caught render error becomes a
// legible recovery panel rather than a blank page.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

/** Props accepted by {@link ErrorBoundary}. */
export type ErrorBoundaryProps = {
    /** The subtree the boundary protects. */
    children: ReactNode;
};

/** Internal state: the caught error, or null while the subtree is healthy. */
type ErrorBoundaryState = {
    error: Error | null;
};

/**
 * Catches render errors from its subtree and shows a recovery panel with the
 * error message and a reload action. React only supports error boundaries as
 * class components, hence the class.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    override state: ErrorBoundaryState = { error: null };

    /**
     * Maps a thrown value into fallback state so the next render shows the
     * recovery panel.
     *
     * @param error - The value thrown by a descendant during render.
     * @returns The state patch recording the error.
     */
    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    /**
     * Logs the caught error and its component stack for diagnosis.
     *
     * @param error - The value thrown by a descendant.
     * @param info - React's component stack for the failure.
     */
    override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("Viewer error boundary caught an error.", error, info.componentStack);
    }

    override render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <Empty role="alert" className="min-h-svh gap-6 px-4 py-10">
                <EmptyHeader>
                    <EmptyTitle>Something went wrong</EmptyTitle>
                    <EmptyDescription>{error.message}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button onClick={() => window.location.reload()}>Reload the viewer</Button>
                </EmptyContent>
            </Empty>
        );
    }
}
