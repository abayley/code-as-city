/** Opens the embedded evaluation store. */
import Database from "better-sqlite3";

export function openStore(): unknown {
    return new Database("mini.db");
}
