// D3 COPY-attribution: the one home for the two mode-specific exclusion rules
// that decide whether a Dockerfile COPY directory attributes source. Both map
// modes bind a service to its Dockerfile and read `service.copies` (parsed and
// `./`-normalised once in dockerfile.ts), but each drops a different class of
// COPY that would otherwise mis-attribute:
//
//   - the deployment map drops a COPY whose room reads as shared plumbing (C2:
//     the utility-room filter, plus a literal `lib` directory);
//   - the overview drops a COPY coarser than room granularity (O9: a bare `src`
//     copied wholesale as a packaging convenience).
//
// They live together here, as one function over a named rule, so the two rules
// are visible side by side rather than re-implemented independently in the two
// assemblers.
import { basename } from "node:path";

/**
 * Normalises a Dockerfile COPY source into the directory key used for
 * attribution: the leading `./` is already stripped when the Dockerfile is
 * parsed (dockerfile.ts), so this strips only a trailing slash. Every consumer
 * of `service.copies` — the deployment host districts, the overview dir→host
 * map, and reachability's host-deploy roots — normalises the same way here, so
 * the containment tests they run all agree on the key.
 *
 * @param copy - A raw COPY source from `service.copies`.
 * @returns The normalised COPY directory (no trailing slash).
 */
export function normaliseCopyDir(copy: string): string {
    return copy.replace(/\/$/, "");
}

/**
 * A mode's COPY-directory exclusion rule.
 *
 * - `utility-room` (deployment / C2): excludes a literal `lib` directory, and a
 *   COPY whose resolved room reads as a shared utility.
 * - `coarser-than-room` (overview / O9): excludes a COPY directory that strictly
 *   contains an active room directory (so it is coarser than room granularity).
 */
export type CopyExclusionRule =
    | {
          kind: "utility-room";
          /** Resolves a COPY directory to its owning room id, or null/undefined when none. */
          roomIdForCopy: (copy: string) => string | null | undefined;
          /** Whether a room id reads as shared plumbing (high fan-in, low fan-out). */
          isUtilityRoom: (roomId: string) => boolean;
      }
    | {
          kind: "coarser-than-room";
          /** The directories of the active rooms, to test containment against. */
          activeRoomDirs: readonly string[];
      };

/**
 * Whether a normalised COPY directory should be excluded from source
 * attribution under the given mode's rule (D3). The single decision point for
 * both the deployment utility-room filter and the overview coarser-than-room
 * skip.
 *
 * @param copy - The normalised COPY directory (trailing slash already stripped).
 * @param rule - The mode's exclusion rule.
 * @returns True when the COPY must not attribute source.
 */
export function isExcludedCopyDir(copy: string, rule: CopyExclusionRule): boolean {
    if (rule.kind === "utility-room") {
        if (basename(copy) === "lib") return true; // shared plumbing, not shape
        const roomId = rule.roomIdForCopy(copy);
        return Boolean(roomId && rule.isUtilityRoom(roomId));
    }
    // A COPY of a whole dominant source root (the dashboard image copying bare
    // `src` for its client bundle) is a packaging convenience, not module
    // attribution: exclude a dir that strictly contains a room dir.
    return rule.activeRoomDirs.some((dir) => dir.startsWith(`${copy}/`));
}
