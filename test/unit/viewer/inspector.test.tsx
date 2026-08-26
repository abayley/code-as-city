import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Inspector, type InspectorContent } from "@/components/inspector";

const mapContent: InspectorContent = {
    kind: "map",
    title: "Checkout",
    paragraphs: ["Payments and fulfilment.", "Generated 2026-08-26."],
    contents: [
        { name: "systems", value: "7" },
        { name: "external systems", value: "2" },
    ],
};

const nodeContent: InspectorContent = {
    kind: "node",
    nodeId: "checkout-api",
    title: "Checkout API",
    typeLabel: "System with 4 rooms",
    paragraphs: ["Takes orders and charges cards."],
    sources: [
        { key: "a", label: "src/api/checkout.ts:12", tag: "handler", href: "https://example.test/checkout.ts#L12" },
        { key: "b", label: "src/api/internal.ts" },
    ],
    stats: [{ name: "loc", value: "412" }],
};

describe("Inspector", () => {
    it("given map content, when it renders, then the map title, paragraphs and contents rows are shown", () => {
        render(<Inspector content={mapContent} />);
        expect(screen.getByText("Checkout")).toBeInTheDocument();
        expect(screen.getByText("Payments and fulfilment.")).toBeInTheDocument();
        expect(screen.getByText("Contents")).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "systems" })).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "7" })).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "external systems" })).toBeInTheDocument();
    });

    it("given map content with no contents rows, when it renders, then the contents table is omitted", () => {
        render(<Inspector content={{ ...mapContent, contents: [] }} />);
        expect(screen.queryByText("Contents")).not.toBeInTheDocument();
    });

    it("given node content, when it renders, then the title, type line, description and stats are shown", () => {
        render(<Inspector content={nodeContent} />);
        expect(screen.getByText("Checkout API")).toBeInTheDocument();
        expect(screen.getByText("System with 4 rooms")).toBeInTheDocument();
        expect(screen.getByText("Takes orders and charges cards.")).toBeInTheDocument();
        expect(screen.getByText("Stats")).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "loc" })).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "412" })).toBeInTheDocument();
    });

    it("given a source with a URL, when it renders, then it is a new-tab link to that URL", () => {
        render(<Inspector content={nodeContent} />);
        const link = screen.getByRole("link", { name: "Open src/api/checkout.ts:12 in source" });
        expect(link).toHaveAttribute("href", "https://example.test/checkout.ts#L12");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveTextContent("handler");
    });

    it("given a source without a URL, when it renders, then it is shown as plain text", () => {
        render(<Inspector content={nodeContent} />);
        expect(screen.getByText("src/api/internal.ts")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /internal\.ts/ })).not.toBeInTheDocument();
    });

    it("given node content with no sources, when it renders, then the source-files card is omitted", () => {
        render(<Inspector content={{ ...nodeContent, sources: [] }} />);
        expect(screen.queryByText("Source files")).not.toBeInTheDocument();
    });
});
