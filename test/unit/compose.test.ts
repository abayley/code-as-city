import { describe, expect, it } from "vitest";
import { parseComposeServices } from "../../src/lib/compose";

describe("parseComposeServices", () => {
    it("given services with image, build dockerfile, ports and depends_on list, when parsed, then all fields land", () => {
        const text = [
            "services:",
            "  api:",
            "    build:",
            "      context: .",
            "      dockerfile: packages/api/Dockerfile",
            "    ports:",
            '      - "3000:3000"',
            "    depends_on:",
            "      - db",
            "      - cache",
            "  db:",
            "    image: postgres:16",
            "",
        ].join("\n");
        expect(parseComposeServices(text)).toEqual([
            {
                name: "api",
                context: ".",
                dockerfile: "packages/api/Dockerfile",
                hasPorts: true,
                dependsOn: ["db", "cache"],
                dependsOnIndent: 4,
            },
            { name: "db", image: "postgres:16" },
        ]);
    });

    it("given a build context and dockerfile, when parsed, then both are captured", () => {
        const text = [
            "services:",
            "  ml:",
            "    build:",
            "      context: ../machine-learning",
            "      dockerfile: Dockerfile",
            "",
        ].join("\n");
        expect(parseComposeServices(text)).toEqual([
            { name: "ml", context: "../machine-learning", dockerfile: "Dockerfile" },
        ]);
    });

    it("given a service bind-mounting the repo root, when parsed, then the dev-environment signal is set (HC-024)", () => {
        const text = [
            "services:",
            "  dev:",
            "    build:",
            "      context: .",
            "      dockerfile: Dockerfile",
            "    volumes:",
            "      - .:/mermaid",
            "",
        ].join("\n");
        expect(parseComposeServices(text)).toMatchObject([{ name: "dev", devBindMount: true }]);
    });

    it("given the map form of depends_on, when parsed, then service names are collected", () => {
        const text = ["services:", "  api:", "    depends_on:", "      db:", "        condition: service_healthy"].join(
            "\n",
        );
        expect(parseComposeServices(text)[0]?.dependsOn).toEqual(["db"]);
    });

    it("given comments and a following top-level key, when parsed, then the services block ends there", () => {
        const text = ["services:", "  # comment", "  api:", "    image: x", "volumes:", "  data:"].join("\n");
        expect(parseComposeServices(text)).toEqual([{ name: "api", image: "x" }]);
    });

    it("given 4-space indentation, when parsed, then no services are recognised (known limitation)", () => {
        const text = ["services:", "    api:", "        image: x"].join("\n");
        expect(parseComposeServices(text)).toEqual([]);
    });
});
