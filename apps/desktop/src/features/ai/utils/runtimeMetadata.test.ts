import { describe, expect, it } from "vitest";
import {
    buildFallbackRuntimeDescriptors,
    getRuntimeDisplayName,
    PROVIDER_CATALOG,
} from "./runtimeMetadata";

describe("runtimeMetadata", () => {
    it("includes native ACP runtimes in the provider catalog", () => {
        expect(PROVIDER_CATALOG).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "kilo-acp",
                    name: "Kilo",
                    company: "Kilo Code",
                }),
                expect.objectContaining({
                    id: "opencode-acp",
                    name: "OpenCode",
                    company: "OpenCode",
                }),
                expect.objectContaining({
                    id: "grok-acp",
                    name: "Grok",
                    company: "xAI",
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
                expect.objectContaining({
                    runtime: expect.objectContaining({
                        id: "opencode-acp",
                        name: "OpenCode ACP",
                        description:
                            "OpenCode CLI running as a native ACP agent.",
                    }),
                }),
                expect.objectContaining({
                    runtime: expect.objectContaining({
                        id: "grok-acp",
                        name: "Grok ACP",
                        description: "Grok CLI running as a native ACP agent.",
                        capabilities: expect.arrayContaining([
                            "attachments",
                            "permissions",
                            "plans",
                            "terminal_output",
                            "create_session",
                        ]),
                    }),
                }),
            ]),
        );
    });

    it("only advertises native resume in fallback descriptors for verified runtimes", () => {
        const descriptors = buildFallbackRuntimeDescriptors();
        const resumeRuntimeIds = descriptors
            .filter((descriptor) =>
                descriptor.runtime.capabilities.includes("resume_session"),
            )
            .map((descriptor) => descriptor.runtime.id);

        expect(resumeRuntimeIds).toEqual(["codex-acp"]);
    });

    it("normalizes runtime display names for the UI", () => {
        expect(getRuntimeDisplayName("kilo-acp", "Kilo ACP")).toBe("Kilo");
        expect(getRuntimeDisplayName("kilo-acp")).toBe("Kilo");
        expect(getRuntimeDisplayName("grok-acp")).toBe("Grok");
        expect(getRuntimeDisplayName("opencode-acp")).toBe("OpenCode");
        expect(getRuntimeDisplayName(undefined, undefined)).toBe("Assistant");
    });
});
