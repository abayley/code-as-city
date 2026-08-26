/** End-to-end runner, invoked by the package's own `e2e` script only. */
import { spinUp } from "./harness.ts";

export function run(): void {
    const harness = spinUp();
    process.stdout.write(`running e2e against ${harness}\n`);
}

run();
