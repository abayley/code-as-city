import { formatGreeting } from "@mini/shared";
import { loadConfig } from "./config";

/** Starts the HTTP server. */
export function startServer(): string {
    const config = loadConfig();
    return formatGreeting(config.name);
}
