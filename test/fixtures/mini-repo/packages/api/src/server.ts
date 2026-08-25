import { formatGreeting } from "@mini/shared";
import { loadConfig } from "./config";
import { openStore } from "./store";
import { sweep } from "./jobs/sweep";
import { log } from "./lib/log";
import { health } from "./routes/health";

/** Starts the HTTP server. */
export function startServer(): string {
    const config = loadConfig();
    openStore();
    log(health());
    log(sweep());
    return formatGreeting(config.name);
}
