import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-server API: lets the viewer browse server-side folders and run the
// deterministic generator against one. Localhost-only by Vite's defaults;
// do not expose this server on a network interface.
function mapApiPlugin() {
    return {
        name: "code-as-city-api",
        configureServer(server) {
            server.middlewares.use("/api/browse", (req, res) => {
                try {
                    const url = new URL(req.url, "http://localhost");
                    const path = resolve(url.searchParams.get("path") || homedir());
                    const entries = readdirSync(path, { withFileTypes: true })
                        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                        .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                    res.setHeader("content-type", "application/json");
                    res.end(
                        JSON.stringify({
                            path,
                            parent: dirname(path),
                            entries,
                            isRepo: existsSync(join(path, ".git")),
                        }),
                    );
                } catch (error) {
                    res.statusCode = 400;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
                }
            });

            server.middlewares.use("/api/generate", (req, res) => {
                if (req.method !== "POST") {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                let body = "";
                req.on("data", (chunk) => {
                    body += chunk;
                });
                req.on("end", () => {
                    const fail = (status, message) => {
                        res.statusCode = status;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: message }));
                    };
                    try {
                        const request = JSON.parse(body);
                        const repo = resolve(String(request.repoPath ?? ""));
                        const overview = Boolean(request.overview);
                        if (!statSync(repo).isDirectory()) {
                            fail(400, "Not a directory.");
                            return;
                        }
                        const outDir = resolve("out", `${basename(repo)}${overview ? "-overview" : ""}`);
                        const args = [resolve("src/generate-map.ts"), repo, "--out-dir", outDir];
                        if (overview) args.push("--overview");
                        const child = spawn("bun", args, {
                            cwd: resolve("."),
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        let stderr = "";
                        child.stderr.on("data", (chunk) => {
                            stderr += chunk;
                        });
                        child.on("error", (error) => fail(500, error.message));
                        child.on("exit", (code) => {
                            if (code !== 0) {
                                fail(500, stderr.trim() || `Generator exited with code ${code}.`);
                                return;
                            }
                            try {
                                const jsonPath = join(outDir, "map.json");
                                const map = JSON.parse(readFileSync(jsonPath, "utf8"));
                                res.setHeader("content-type", "application/json");
                                res.end(JSON.stringify({ map, jsonPath, repoPath: repo }));
                            } catch (error) {
                                fail(500, error instanceof Error ? error.message : String(error));
                            }
                        });
                    } catch (error) {
                        fail(400, error instanceof Error ? error.message : String(error));
                    }
                });
            });
        },
    };
}

export default defineConfig({
    plugins: [react(), tailwindcss(), mapApiPlugin()],
    resolve: {
        alias: {
            "@": resolve("viewer"),
        },
    },
});
