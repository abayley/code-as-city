/** Nightly sweep job. */
import { log } from "../lib/log";

export function sweep(): string {
    return log("swept");
}

/** Sweeps via the ml service, whose base URL comes from the environment. */
export async function sweepRemote(): Promise<string> {
    const base = process.env.ML_URL ?? "http://ml:8000";
    const response = await fetch(`${base}/sweep`);
    return response.text();
}
