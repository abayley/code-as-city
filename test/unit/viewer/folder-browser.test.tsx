import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "@/components/folder-browser";
import type { CityMap } from "@/lib/city-map";

/** One request the fake fetch was asked to make. */
type RecordedRequest = {
    /** Requested URL, as the component wrote it. */
    url: string;
    /** HTTP method, defaulting to GET. */
    method: string;
    /** Parsed JSON body, for the POSTs this component makes. */
    body: unknown;
};

/** A directory listing, in the shape `/api/browse` returns. */
type Listing = {
    path: string;
    parent: string;
    entries: Array<{ name: string; path: string }>;
    isRepo: boolean;
};

const generatedMap: CityMap = {
    schemaVersion: 1,
    id: "code-as-city",
    name: "Code as City",
    nodes: [{ id: "root", label: "Root", kind: "scope", archetype: "district" }],
    edges: [],
};

const homeListing: Listing = {
    path: "/home/dev",
    parent: "/home",
    entries: [
        { name: "projects", path: "/home/dev/projects" },
        { name: "notes", path: "/home/dev/notes" },
    ],
    isRepo: false,
};

const projectsListing: Listing = {
    path: "/home/dev/projects",
    parent: "/home/dev",
    entries: [{ name: "code-as-city", path: "/home/dev/projects/code-as-city" }],
    isRepo: true,
};

/**
 * A recording fake for the `fetch` seam: it answers `/api/browse` from the
 * listings it was given (keyed by the requested path, falling back to the
 * first listing) and `/api/generate` with a fixed generated map, keeping every
 * request for the test to assert on.
 */
class FetchFake {
    /** Requests made so far, oldest first. */
    readonly requests: RecordedRequest[] = [];

    /**
     * @param listings - Listings the browse endpoint can return, keyed by the
     *   absolute path each one stands for.
     * @param generateResult - The body `/api/generate` responds with.
     */
    constructor(
        private readonly listings: Record<string, Listing>,
        private readonly generateResult: { map: CityMap; jsonPath: string },
    ) {}

    /**
     * Answers one request, recording it first.
     *
     * @param input - Request URL, as passed to `fetch`.
     * @param init - Request options, when the caller supplied any.
     * @returns The canned response for that endpoint.
     */
    readonly fetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const rawBody = typeof init?.body === "string" ? init.body : undefined;
        this.requests.push({
            url,
            method: init?.method ?? "GET",
            body: rawBody === undefined ? undefined : JSON.parse(rawBody),
        });
        if (url.startsWith("/api/generate")) return Response.json(this.generateResult);
        const requested = new URL(url, "http://localhost").searchParams.get("path");
        const listing = (requested === null ? undefined : this.listings[requested]) ?? Object.values(this.listings)[0];
        return Response.json(listing);
    };
}

let fake: FetchFake;
const originalFetch = globalThis.fetch;

beforeEach(() => {
    // The browser remembers its last folder in localStorage; clear it so each
    // test starts from the server default listing.
    localStorage.clear();
    fake = new FetchFake(
        { "/home/dev": homeListing, "/home/dev/projects": projectsListing, "/home": homeListing },
        { map: generatedMap, jsonPath: "/home/dev/projects/code-as-city/out/map.json" },
    );
    globalThis.fetch = fake.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("FolderBrowser", () => {
    it("given a browse response, when the dialog opens, then its entries are listed", async () => {
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        expect(await screen.findByText("projects/")).toBeInTheDocument();
        expect(screen.getByText("notes/")).toBeInTheDocument();
        expect(screen.getByLabelText("Parent folder")).toBeInTheDocument();
    });

    it("given a listed folder, when it is clicked, then that folder is browsed", async () => {
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        await userEvent.click(await screen.findByRole("button", { name: "projects/" }));
        await waitFor(() => expect(screen.getByText("code-as-city/")).toBeInTheDocument());
        expect(fake.requests.at(-1)?.url).toBe(`/api/browse?path=${encodeURIComponent("/home/dev/projects")}`);
    });

    it("given the parent row, when it is clicked, then the parent folder is browsed", async () => {
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        await userEvent.click(await screen.findByLabelText("Parent folder"));
        await waitFor(() => expect(fake.requests.at(-1)?.url).toBe(`/api/browse?path=${encodeURIComponent("/home")}`));
    });

    it("given the module-overview button, when pressed, then the overview request is posted", async () => {
        const onGenerated = vi.fn();
        render(<FolderBrowser onClose={() => {}} onGenerated={onGenerated} />);
        await screen.findByText("projects/");
        await userEvent.click(screen.getByRole("button", { name: /Module overview/ }));
        await waitFor(() =>
            expect(onGenerated).toHaveBeenCalledWith({
                map: generatedMap,
                jsonPath: "/home/dev/projects/code-as-city/out/map.json",
            }),
        );
        expect(fake.requests.at(-1)).toMatchObject({
            url: "/api/generate",
            method: "POST",
            body: { repoPath: "/home/dev", overview: true },
        });
    });

    it("given the deployment-map button, when pressed, then a deployment map is requested", async () => {
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        await screen.findByText("projects/");
        await userEvent.click(screen.getByRole("button", { name: /Deployment map/ }));
        await waitFor(() => expect(fake.requests.at(-1)?.body).toEqual({ repoPath: "/home/dev", overview: false }));
    });

    it("given a failing generate, when a map is requested, then the error is shown and nothing is handed back", async () => {
        const onGenerated = vi.fn();
        globalThis.fetch = async (input, init) => {
            if (String(input).startsWith("/api/generate")) return Response.json({ error: "Not a directory." });
            return fake.fetch(input, init);
        };
        render(<FolderBrowser onClose={() => {}} onGenerated={onGenerated} />);
        await screen.findByText("projects/");
        await userEvent.click(screen.getByRole("button", { name: /Deployment map/ }));
        expect(await screen.findByText("Not a directory.")).toBeInTheDocument();
        expect(onGenerated).not.toHaveBeenCalled();
    });

    it("given a folder it settled on, when reopened, then it starts from that folder", async () => {
        // The first mount records the settled folder; a second mount reads it
        // back from storage instead of starting at the server default.
        localStorage.setItem("code-as-city:last-folder", "/home/dev/projects");
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        await waitFor(() =>
            expect(fake.requests.at(-1)?.url).toBe(`/api/browse?path=${encodeURIComponent("/home/dev/projects")}`),
        );
    });

    it("given the folder list, when Down then Enter is pressed, then the highlighted folder is browsed", async () => {
        render(<FolderBrowser onClose={() => {}} onGenerated={() => {}} />);
        await screen.findByText("projects/");
        await userEvent.keyboard("{ArrowDown}{Enter}");
        await waitFor(() =>
            expect(fake.requests.at(-1)?.url).toBe(`/api/browse?path=${encodeURIComponent("/home/dev/projects")}`),
        );
    });

    it("given the dialog, when Cmd+Enter is pressed, then the map is generated", async () => {
        const onGenerated = vi.fn();
        render(<FolderBrowser onClose={() => {}} onGenerated={onGenerated} />);
        await screen.findByText("projects/");
        await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
        await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
        expect(fake.requests.at(-1)?.body).toEqual({ repoPath: "/home/dev", overview: false });
    });

    it("given the dialog, when Escape is pressed, then onClose fires", async () => {
        const onClose = vi.fn();
        render(<FolderBrowser onClose={onClose} onGenerated={() => {}} />);
        await screen.findByText("projects/");
        await userEvent.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalled();
    });

    it("given the dialog, when Cancel is pressed, then onClose fires", async () => {
        const onClose = vi.fn();
        render(<FolderBrowser onClose={onClose} onGenerated={() => {}} />);
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
