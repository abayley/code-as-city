import * as React from "react";

/** Viewport width, in pixels, below which the layout is treated as mobile. */
const MOBILE_BREAKPOINT = 768;

/**
 * Tracks whether the viewport is narrower than the mobile breakpoint,
 * re-rendering when it crosses. Reports false during the first render, before
 * the media query has been read.
 *
 * @returns Whether the viewport is currently mobile-width.
 */
export function useIsMobile(): boolean {
    const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

    React.useEffect(() => {
        const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
        const onChange = () => {
            setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
        };
        mql.addEventListener("change", onChange);
        setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    return !!isMobile;
}
