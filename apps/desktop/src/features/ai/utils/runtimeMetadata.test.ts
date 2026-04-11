import { describe, expect, it } from "vitest";
import {
    buildFallbackRuntimeDescriptors,
    getRuntimeDisplayName,
    PROVIDER_CATALOG,
} from "./runtimeMetadata";

describe("runtimeMetadata", () => {
    it("includes Kilo in the provider catalog", () => {
        expect(PROVIDER_CATALOG).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "kilo-acp",
                    name: "Kilo",
                    company: "Kilo Code",
                }),
            ]),
        );
    });

    it("builds fallback descriptors for all supported ACP runtimes", () => {
        const descriptors = buildFallbackRuntimeDescriptors();
        expect(descriptors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    runtime: expect.objectContaining({
                        id: "kilo-acp",
                        name: "Kilo ACP",
                    }),
                }),
            ]),
        );
    });

    it("normalizes runtime display names for the UI", () => {
        expect(getRuntimeDisplayName("kilo-acp", "Kilo ACP")).toBe("Kilo");
        expect(getRuntimeDisplayName("kilo-acp")).toBe("Kilo");
        expect(getRuntimeDisplayName(undefined, undefined)).toBe("Assistant");
    });
});
