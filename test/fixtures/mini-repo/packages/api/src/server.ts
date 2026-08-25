import { formatGreeting } from "@mini/shared";
import { loadConfig } from "./config";
import { openStore } from "./store";

/** Starts the HTTP server. */
export function startServer(): string {
    const config = loadConfig();
    openStore();
    return formatGreeting(config.name);
}
