import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["test/fixtures/**", "node_modules/**"],
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            include: ["src/**", "viewer/lib/**"],
        },
    },
});
