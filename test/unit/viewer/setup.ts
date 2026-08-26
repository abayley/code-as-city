// Shared jsdom setup for the viewer chrome tests: jest-dom's matchers, plus
// the browser APIs the shadcn/Base UI components expect but jsdom lacks.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * A minimal in-memory Storage, standing in for the browser's localStorage.
 *
 * Node 26 defines a `localStorage` global of its own that is unavailable
 * without `--localstorage-file`, and vitest's jsdom environment leaves
 * pre-existing globals alone, so jsdom's implementation never reaches the
 * tests. This supplies the small part of the API the viewer uses.
 */
class MemoryStorage implements Storage {
    private readonly entries = new Map<string, string>();

    get length(): number {
        return this.entries.size;
    }

    /** Forgets every stored entry. */
    clear(): void {
        this.entries.clear();
    }

    /**
     * @param key - Entry to read.
     * @returns The stored value, or null when the key is unknown.
     */
    getItem(key: string): string | null {
        return this.entries.get(key) ?? null;
    }

    /**
     * @param index - Zero-based position in insertion order.
     * @returns The key at that position, or null when out of range.
     */
    key(index: number): string | null {
        return [...this.entries.keys()][index] ?? null;
    }

    /**
     * @param key - Entry to forget.
     */
    removeItem(key: string): void {
        this.entries.delete(key);
    }

    /**
     * @param key - Entry to write.
     * @param value - Value to store against it.
     */
    setItem(key: string, value: string): void {
        this.entries.set(key, value);
    }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

// Base UI's popup and sidebar primitives query these; jsdom implements neither.
if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    });
}
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
    cleanup();
});
