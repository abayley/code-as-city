import { describe, expect, it } from "vitest";
import { kebab, titleCase } from "../../src/lib/text";

describe("kebab", () => {
    it("given mixed punctuation and case, when kebabbed, then collapses to single dashes", () => {
        expect(kebab("Hello,  World! v2")).toBe("hello-world-v2");
    });

    it("given leading and trailing separators, when kebabbed, then trims them", () => {
        expect(kebab("--Already--Kebab--")).toBe("already-kebab");
    });

    it("given no usable characters, when kebabbed, then returns the placeholder", () => {
        expect(kebab("!!!")).toBe("x");
    });
});

describe("titleCase", () => {
    it("given dash and underscore separators, when title-cased, then capitalises each word", () => {
        expect(titleCase("otel-collector_stack")).toBe("Otel Collector Stack");
    });

    it("given already-capitalised text, when title-cased, then leaves inner letters alone", () => {
        expect(titleCase("aria-evals")).toBe("Aria Evals");
    });

    it("given emoji in the name, when title-cased, then strips them and tidies the whitespace (HC-006)", () => {
        expect(titleCase("Release 🚀")).toBe("Release");
        expect(titleCase("Generate Weekly Community Report 📊")).toBe("Generate Weekly Community Report");
        expect(titleCase("Gemini Scheduled PR Triage 🚀")).toBe("Gemini Scheduled PR Triage");
    });
});
