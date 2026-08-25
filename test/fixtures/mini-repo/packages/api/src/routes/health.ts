/** Health check route. */
import { log } from "../lib/log";

export function health(): string {
    return log("healthy");
}
