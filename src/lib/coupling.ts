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

/** archunitts-style fan-in/fan-out/instability per node from directed edge pairs. */
export function couplingFromEdges(pairs: Iterable<readonly [string, string]>): Map<string, Coupling> {
    const stats = new Map<string, { in: Set<string>; out: Set<string> }>();
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

    const isMidFile = (file: string): boolean => {
        const c = fileCoupling.get(file);
        return Boolean(
            c &&
                c.in + c.out >= MID_MIN_DEGREE &&
                c.instability > MID_INSTABILITY[0] &&
                c.instability < MID_INSTABILITY[1],
        );
    };

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
