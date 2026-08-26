import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects, because the generator and the viewer want different worlds:
// the generator reads the filesystem and needs plain node, while the viewer
// chrome needs a DOM plus JSX transformation. Splitting them keeps the node
// suite free of jsdom's start-up cost.
export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "generator",
                    environment: "node",
                    include: ["test/**/*.test.ts"],
                    exclude: ["test/fixtures/**", "node_modules/**"],
                },
            },
            {
                plugins: [react()],
                resolve: { alias: { "@": resolve("viewer") } },
                test: {
                    name: "viewer",
                    environment: "jsdom",
                    // A real origin, so the theme hook's localStorage exists;
                    // jsdom refuses storage on the default opaque origin.
                    environmentOptions: { jsdom: { url: "http://localhost/" } },
                    include: ["test/unit/viewer/**/*.test.tsx"],
                    setupFiles: ["test/unit/viewer/setup.ts"],
                },
            },
        ],
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            include: ["src/**", "viewer/lib/**"],
        },
    },
});
