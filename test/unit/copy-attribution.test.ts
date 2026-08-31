import { describe, expect, it } from "vitest";
import { isExcludedCopyDir, normaliseCopyDir } from "../../src/lib/copy-attribution";

describe("normaliseCopyDir", () => {
    it("strips a trailing slash so a dir key matches its contained files", () => {
        expect(normaliseCopyDir("packages/api/src/")).toBe("packages/api/src");
    });

    it("leaves a dir with no trailing slash unchanged", () => {
        expect(normaliseCopyDir("packages/api/src")).toBe("packages/api/src");
    });

    it("strips only the final slash, not interior ones", () => {
        expect(normaliseCopyDir("packages/api/")).toBe("packages/api");
    });
});

describe("isExcludedCopyDir — deployment utility-room rule (C2)", () => {
    const rule = (over: { roomId?: string | null; utility?: boolean } = {}) =>
        ({
            kind: "utility-room" as const,
            roomIdForCopy: () => over.roomId ?? null,
            isUtilityRoom: () => over.utility ?? false,
        }) as const;

    it("excludes a COPY of a literal lib directory as shared plumbing", () => {
        expect(isExcludedCopyDir("packages/core/lib", rule({ roomId: "some-room" }))).toBe(true);
    });

    it("excludes a COPY whose room reads as a shared utility", () => {
        expect(isExcludedCopyDir("packages/core/util", rule({ roomId: "util-room", utility: true }))).toBe(true);
    });

    it("keeps a COPY whose room is not a utility", () => {
        expect(isExcludedCopyDir("packages/core/domain", rule({ roomId: "domain-room", utility: false }))).toBe(false);
    });

    it("keeps a COPY that resolves to no room", () => {
        expect(isExcludedCopyDir("packages/core/domain", rule({ roomId: null }))).toBe(false);
    });
});

describe("isExcludedCopyDir — overview coarser-than-room rule (O9)", () => {
    const rule = (activeRoomDirs: string[]) => ({ kind: "coarser-than-room" as const, activeRoomDirs }) as const;

    it("excludes a COPY dir that strictly contains a room dir (bare src copying its client bundle)", () => {
        expect(isExcludedCopyDir("src", rule(["src/app", "src/server"]))).toBe(true);
    });

    it("keeps a COPY dir that equals a room dir", () => {
        expect(isExcludedCopyDir("src/app", rule(["src/app"]))).toBe(false);
    });

    it("keeps a COPY dir nested inside a room dir (not coarser)", () => {
        expect(isExcludedCopyDir("src/app/feature", rule(["src/app"]))).toBe(false);
    });

    it("keeps a COPY dir when no room dir sits under it", () => {
        expect(isExcludedCopyDir("services/api", rule(["src/app"]))).toBe(false);
    });
});
