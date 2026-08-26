/** VS Code extension activation entry. */
import { register } from "./commands.ts";

export function activate(): void {
    register();
}
