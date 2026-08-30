// The React shell over the pure navigation state machine (lib/navigation.ts):
// it holds the raw state, exposes the clamped view and the five gestures, and
// owns the global Escape listener so "Escape steps back one level" is the same
// policy the back button uses. All decisions live in the pure module; this file
// only wires them to React.
import { useEffect, useState } from "react";
import {
    back,
    deriveNavigation,
    deselect,
    explore,
    exploreDistrict,
    INITIAL_NAVIGATION,
    type NavigationContext,
    type NavigationState,
    type NavigationView,
    select,
} from "../lib/navigation";

/** The navigation view plus the five gestures that drive the city lattice. */
export type Navigation = {
    /** The clamped, render-ready mode and ids every consumer reads. */
    view: NavigationView;
    /** Selects a node (single click). */
    select: (nodeId: string) => void;
    /** Opens a node (double-click or rail click). */
    explore: (nodeId: string) => void;
    /** Toggles district mode. */
    exploreDistrict: (districtId: string) => void;
    /** Steps back one drill-down level (the Escape / back-button action). */
    back: () => void;
    /** Handles a background click. */
    deselect: () => void;
};

/**
 * Drives the campus/district/focus/interior lattice for one loaded map.
 *
 * @param context - The map-derived lookups the machine reads; memoise it so the
 *   Escape listener re-subscribes only when the map changes.
 * @returns The clamped view and the five gesture callbacks.
 */
export function useNavigation(context: NavigationContext): Navigation {
    const [state, setState] = useState<NavigationState>(INITIAL_NAVIGATION);
    const view = deriveNavigation(state, context);

    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            setState((current) => back(current, context));
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [context]);

    // The gesture callbacks are recreated each render (the pre-refactor
    // component defined them inline too); memoising them bought nothing while
    // `view` changed identity every render, so the shell returns them directly.
    return {
        view,
        select: (nodeId: string) => setState((current) => select(current, context, nodeId)),
        explore: (nodeId: string) => setState((current) => explore(current, context, nodeId)),
        exploreDistrict: (districtId: string) => setState((current) => exploreDistrict(current, context, districtId)),
        back: () => setState((current) => back(current, context)),
        deselect: () => setState((current) => deselect(current, context)),
    };
}
