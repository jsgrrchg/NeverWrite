import { describe, expect, it } from "vitest";
import type { NoteDto, VaultEntryDto } from "../store/vaultStore";
import type { VaultNoteChange } from "../store/vaultStore";
import {
    getVaultChangeSyncStrategy,
    type VaultChangeSyncStrategy,
} from "./vaultChangeSync";

function note(id: string): NoteDto {
    const fileName = id.split("/").pop() ?? id;
    return {
        id,
        path: `/vault/${id}.md`,
        title: fileName,
        modified_at: 1,
        created_at: 1,
    };
}

function entry(path: string, kind: VaultEntryDto["kind"]): VaultEntryDto {
    const fileName = path.split("/").pop() ?? path;
    const dotIndex = fileName.lastIndexOf(".");
    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName,
        file_name: fileName,
        extension: dotIndex > 0 ? fileName.slice(dotIndex + 1) : "",
        kind,
        modified_at: 1,
        created_at: 1,
        size: kind === "folder" ? 0 : 10,
        mime_type: kind === "folder" ? null : "text/plain",
    };
}

function change(overrides: Partial<VaultNoteChange>): VaultNoteChange {
    return {
        vault_path: "/vault",
        kind: "upsert",
        note: null,
        note_id: null,
        entry: null,
        relative_path: null,
        origin: "external",
        op_id: null,
        revision: 1,
        content_hash: null,
        graph_revision: 1,
        ...overrides,
    };
}

describe("getVaultChangeSyncStrategy", () => {
    it.each([
        ["upsert", { kind: "upsert", note: note("plans/alpha") }],
        ["delete", { kind: "delete", note_id: "plans/alpha" }],
    ] satisfies Array<[string, Partial<VaultNoteChange>]>)(
        "keeps a light sync path for specific note %s events",
        (_label, overrides) => {
            expect(getVaultChangeSyncStrategy(change(overrides))).toBe(
                "apply-note-change-and-refresh-entries",
            );
        },
    );

    it.each([
        [
            "external folder upsert",
            { kind: "upsert", entry: entry("plans", "folder") },
        ],
        [
            "external delete without note_id",
            { kind: "delete", relative_path: "plans" },
        ],
        [
            "external ambiguous upsert",
            { kind: "upsert", relative_path: "plans" },
        ],
    ] satisfies Array<[string, Partial<VaultNoteChange>]>)(
        "refreshes full structure for %s",
        (_label, overrides) => {
            expect(getVaultChangeSyncStrategy(change(overrides))).toBe(
                "refresh-structure",
            );
        },
    );

    it("refreshes only entries for a non-folder file upsert", () => {
        expect(
            getVaultChangeSyncStrategy(
                change({
                    entry: entry("assets/spec.txt", "file"),
                    relative_path: "assets/spec.txt",
                }),
            ),
        ).toBe("refresh-entries");
    });

    it("refreshes full structure for a note entry upsert without note metadata", () => {
        expect(
            getVaultChangeSyncStrategy(
                change({
                    entry: entry("plans/alpha.md", "note"),
                    relative_path: "plans/alpha.md",
                }),
            ),
        ).toBe("refresh-structure");
    });

    it.each([
        ["user", "ignore"],
        ["system", "ignore"],
        ["agent", "refresh-structure"],
        ["unknown", "refresh-structure"],
    ] satisfies Array<[VaultNoteChange["origin"], VaultChangeSyncStrategy]>)(
        "returns %s origin strategy",
        (origin, expected) => {
            expect(
                getVaultChangeSyncStrategy(
                    change({
                        origin,
                        kind: "delete",
                        relative_path: "plans",
                    }),
                ),
            ).toBe(expected);
        },
    );
});
