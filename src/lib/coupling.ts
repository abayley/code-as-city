// Coupling metrics over the import graph and utility-room elimination
// (HEURISTICS.md group C: C1 metrics, C2 elimination).

import type { Room } from "./rooms.ts";

export type Coupling = { in: number; out: number; instability: number };

const UTILITY_MIN_FAN_IN = 3;
const UTILITY_MAX_INSTABILITY = 0.25;
// A significantly coupled file in the middle band (neither leaf nor composer,
// e.g. an annotation-store with in=7 out=4) anchors its module: a room
// containing one is retained even when the room aggregates as a utility.
const MID_MIN_DEGREE = 5;
const MID_INSTABILITY = [0.25, 0.8] as const;

export const COUPLING_THRESHOLDS = {
    utilityMinFanIn: UTILITY_MIN_FAN_IN,
    utilityMaxInstability: UTILITY_MAX_INSTABILITY,
} as const;

/**
 * archunitts-style fan-in/fan-out/instability per node from directed edge pairs.
 *
 * @param pairs - Directed [from, to] dependency pairs; duplicates collapse
 *   (fan counts are over distinct neighbours).
 * @returns Per-node coupling: distinct fan-in, fan-out, and instability
 *   (out / (in + out), defaulting to 1 for isolated nodes).
 */
export function couplingFromEdges(pairs: Iterable<readonly [string, string]>): Map<string, Coupling> {
    const stats = new Map<string, { in: Set<string>; out: Set<string> }>();
    /**
     * Fetches (creating on first sight) the node's neighbour sets.
     *
     * @param id - The node whose stats entry is wanted.
     * @returns The node's mutable in/out neighbour sets.
     */
    const ensure = (id: string) => {
        let s = stats.get(id);
        if (!s) {
            s = { in: new Set(), out: new Set() };
            stats.set(id, s);
        }
        return s;
    };
    for (const [from, to] of pairs) {
        ensure(from).out.add(to);
        ensure(to).in.add(from);
    }
    return new Map(
        [...stats.entries()].map(([id, s]) => {
            const fanIn = s.in.size;
            const fanOut = s.out.size;
            const instability = fanIn + fanOut === 0 ? 1 : fanOut / (fanIn + fanOut);
            return [id, { in: fanIn, out: fanOut, instability }];
        }),
    );
}

export type CouplingAnalysis = {
    fileCoupling: Map<string, Coupling>;
    roomCoupling: Map<string, Coupling>;
    isMidFile: (file: string) => boolean;
    isUtilityRoom: (roomId: string) => boolean;
    eliminatedRooms: { id: string; segment: string; in?: number; out?: number; instability?: number }[];
};

/**
 * Couples files and rooms from the import graph. Utility rooms (high fan-in,
 * low fan-out, instability towards 0) are shared lib-like leaves eliminated
 * from the map, unless anchored by a mid-band file.
 *
 * @param fileEdges - File-level import edges from the import scan.
 * @param roomEdges - Room-level edge counts keyed "from->to".
 * @param rooms - The room map, consulted for each room's files when testing
 *   the mid-band anchor.
 * @returns File and room coupling maps, the mid-file and utility-room
 *   predicates, and the rooms C2 eliminates (with their coupling figures).
 */
export function analyseCoupling(
    fileEdges: readonly { from: string; to: string }[],
    roomEdges: ReadonlyMap<string, number>,
    rooms: ReadonlyMap<string, Room>,
): CouplingAnalysis {
    const fileCoupling = couplingFromEdges(fileEdges.map(({ from, to }) => [from, to] as const));
    const roomCoupling = couplingFromEdges(
        [...roomEdges.keys()].map((k) => {
            const [from = "", to = ""] = k.split("->");
            return [from, to] as const;
        }),
    );

    /**
     * True when the file sits in the mid-coupling band (degree >= 5,
     * instability strictly between the band bounds): such a file anchors its
     * room against C2 elimination.
     *
     * @param file - Repo-relative path of the source file.
     * @returns Whether the file is significantly mid-coupled.
     */
    const isMidFile = (file: string): boolean => {
        const c = fileCoupling.get(file);
        return Boolean(
            c &&
                c.in + c.out >= MID_MIN_DEGREE &&
                c.instability > MID_INSTABILITY[0] &&
                c.instability < MID_INSTABILITY[1],
        );
    };

    /**
     * True when the room aggregates as a shared utility leaf (fan-in >= 3,
     * instability <= 0.25) and no mid-band file anchors it — the C2
     * elimination condition.
     *
     * @param roomId - The room's node id.
     * @returns Whether C2 eliminates the room from the deployment map.
     */
    const isUtilityRoom = (roomId: string): boolean => {
        const c = roomCoupling.get(roomId);
        if (!c || c.in < UTILITY_MIN_FAN_IN || c.instability > UTILITY_MAX_INSTABILITY) return false;
        const room = rooms.get(roomId);
        return !room?.files.some(isMidFile);
    };

    const eliminatedRooms = [...rooms.values()]
        .filter((room) => room.files.length && isUtilityRoom(room.id))
        .map((room) => ({ id: room.id, segment: room.segment, ...roomCoupling.get(room.id) }));

    return { fileCoupling, roomCoupling, isMidFile, isUtilityRoom, eliminatedRooms };
}
