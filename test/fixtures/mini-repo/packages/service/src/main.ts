/** A standalone service: run directly via `bun start`, it serves HTTP. */
import { handle } from "./handler.ts";

Bun.serve({
    port: 8080,
    fetch: handle,
});
