/** Greeter CLI entry point: starts a worker daemon, then greets. */
import { spawn } from "node:child_process";
import { greeting } from "./format.ts";

// D15: a literal spawn target that resolves to an inventoried entry is a daemon.
spawn("./worker.ts", []);

// A spawn on a variable resolves to nothing and must draw no daemon.
const dynamicCommand = process.env.WORKER ?? "true";
spawn(dynamicCommand, []);

process.stdout.write(`${greeting("world")}\n`);
