import { describe, expect, it } from "vitest";
import { isTextLikeVaultEntry } from "./vaultEntries";

describe("vaultEntries", () => {
    it("treats common config files without standard extensions as text", () => {
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: "Dockerfile",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".env.local",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".prettierrc",
                mime_type: null,
            }),
        ).toBe(true);
    });
});
