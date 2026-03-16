import { describe, expect, it } from "vitest";
import {
    getVaultEntryDisplayName,
    isTextLikeVaultEntry,
} from "./vaultEntries";

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
                file_name: "Makefile",
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
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".gitignore",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".eslintrc",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "mk",
                file_name: "rules.mk",
                mime_type: null,
            }),
        ).toBe(true);
    });

    it("falls back to the file name when a file title is empty", () => {
        expect(
            getVaultEntryDisplayName(
                {
                    kind: "file",
                    title: "",
                    file_name: ".gitignore",
                },
                false,
            ),
        ).toBe(".gitignore");
    });
});
