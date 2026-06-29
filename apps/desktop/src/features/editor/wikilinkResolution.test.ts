import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    findWikilinkResource,
    invalidateWikilinkCaches,
} from "./wikilinkResolution";
import {
    useVaultStore,
    type VaultEntryDto,
} from "../../app/store/vaultStore";

vi.mock("@neverwrite/runtime", () => ({ invoke: vi.fn() }));
import { invoke } from "@neverwrite/runtime";

function buildEntry(
    relativePath: string,
    kind: VaultEntryDto["kind"],
    mimeType: string,
): VaultEntryDto {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    const extension = fileName.includes(".")
        ? (fileName.split(".").pop() ?? "")
        : "";
    return {
        id: relativePath,
        path: `/vault/${relativePath}`,
        relative_path: relativePath,
        title: fileName.replace(/\.[^.]+$/, ""),
        file_name: fileName,
        extension,
        kind,
        modified_at: 0,
        created_at: 0,
        size: 0,
        mime_type: mimeType,
    };
}

describe("findWikilinkResource", () => {
    beforeEach(() => {
        invalidateWikilinkCaches("test");
        vi.mocked(invoke).mockResolvedValue([]);
        useVaultStore.setState({
            vaultPath: "/vault",
            resolverRevision: 1,
            entries: [],
            notes: [],
        });
    });

    afterEach(() => {
        invalidateWikilinkCaches("test");
        vi.clearAllMocks();
        useVaultStore.setState({ entries: [], notes: [] });
    });

    it("resolves a note-relative image wikilink as a file resource", async () => {
        useVaultStore.setState({
            entries: [
                buildEntry("projects/assets/diagram.png", "file", "image/png"),
            ],
        });

        const resource = await findWikilinkResource(
            "../assets/diagram.png",
            "projects/notes/current",
        );

        expect(resource).toEqual({
            kind: "file",
            path: "/vault/projects/assets/diagram.png",
            relativePath: "projects/assets/diagram.png",
        });
    });

    it("resolves a note-relative PDF wikilink with a suffix", async () => {
        useVaultStore.setState({
            entries: [
                buildEntry(
                    "projects/assets/spec.pdf",
                    "pdf",
                    "application/pdf",
                ),
            ],
        });

        const resource = await findWikilinkResource(
            "../assets/spec.pdf?page=2",
            "projects/notes/current",
        );

        expect(resource).toEqual({
            kind: "file",
            path: "/vault/projects/assets/spec.pdf",
            relativePath: "projects/assets/spec.pdf",
        });
    });
});
