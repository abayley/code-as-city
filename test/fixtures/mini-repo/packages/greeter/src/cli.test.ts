/** A test that also spawns; being a test file, it must draw no daemon (D15). */
import { spawn } from "node:child_process";

spawn("./worker.ts", []);
