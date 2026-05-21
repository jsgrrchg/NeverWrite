import { describe, expect, it } from "vitest";
import type { NoteDto } from "../../app/store/vaultStore";
import {
    buildFolderMoveOperations,
    canMoveTargetsToFolder,
    buildNoteMoveOperations,
    canMoveFolderToTarget,
    getMoveTargetsCommonParent,
    normalizeMoveTargets,
} from "./fileTreeMoves";

const NOTES: NoteDto[] = [
    {
        id: "notes/alpha",
        path: "/vault/notes/alpha.md",
        title: "Alpha",
        modified_at: 1,
        created_at: 1,
    },
    {
        id: "notes/beta",
        path: "/vault/notes/beta.md",
        title: "Beta",
        modified_at: 1,
        created_at: 1,
    },
    {
        id: "notes/sub/gamma",
        path: "/vault/notes/sub/gamma.md",
        title: "Gamma",
        modified_at: 1,
        created_at: 1,
    },
    {
        id: "archive/delta",
        path: "/vault/archive/delta.md",
        title: "Delta",
        modified_at: 1,
        created_at: 1,
    },
];

const ENTRY = {
    id: "files/readme.txt",
    path: "/vault/files/readme.txt",
    relative_path: "files/readme.txt",
    title: "readme",
    file_name: "readme.txt",
    extension: "txt",
    kind: "file" as const,
    modified_at: 1,
    created_at: 1,
    size: 16,
    mime_type: "text/plain",
};

describe("fileTreeMoves", () => {
    it("builds move operations for multiple notes to a folder", () => {
        expect(
            buildNoteMoveOperations([NOTES[0], NOTES[1]], "archive"),
        ).toEqual([
            {
                note: NOTES[0],
                fromId: "notes/alpha",
                toPath: "archive/alpha",
            },
            {
                note: NOTES[1],
                fromId: "notes/beta",
                toPath: "archive/beta",
            },
        ]);
    });

    it("builds move operations for multiple notes to root", () => {
        expect(buildNoteMoveOperations([NOTES[0], NOTES[1]], "")).toEqual([
            {
                note: NOTES[0],
                fromId: "notes/alpha",
                toPath: "alpha",
            },
            {
                note: NOTES[1],
                fromId: "notes/beta",
                toPath: "beta",
            },
        ]);
    });

    it("builds folder move operations for all descendants", () => {
        expect(buildFolderMoveOperations(NOTES, "notes", "archive")).toEqual([
            {
                note: NOTES[0],
                fromId: "notes/alpha",
                toPath: "archive/notes/alpha",
            },
            {
                note: NOTES[1],
                fromId: "notes/beta",
                toPath: "archive/notes/beta",
            },
            {
                note: NOTES[2],
                fromId: "notes/sub/gamma",
                toPath: "archive/notes/sub/gamma",
            },
        ]);
    });

    it("rejects invalid folder drops into the same folder or a descendant", () => {
        expect(canMoveFolderToTarget("notes", "notes")).toBe(false);
        expect(canMoveFolderToTarget("notes", "notes/sub")).toBe(false);
    });

    it("normalizes move targets nested under selected folders", () => {
        expect(
            normalizeMoveTargets({
                notes: [NOTES[0], NOTES[2], NOTES[3]],
                entries: [ENTRY],
                folderPaths: ["notes", "notes/sub"],
            }),
        ).toEqual({
            notes: [NOTES[3]],
            entries: [ENTRY],
            folderPaths: ["notes"],
        });
    });

    it("allows mixed move targets when at least one item can move", () => {
        expect(
            canMoveTargetsToFolder(
                {
                    notes: [NOTES[0]],
                    entries: [ENTRY],
                    folderPaths: [],
                },
                "files",
            ),
        ).toBe(true);
        expect(
            canMoveTargetsToFolder(
                {
                    notes: [],
                    entries: [ENTRY],
                    folderPaths: [],
                },
                "files",
            ),
        ).toBe(false);
    });

    it("detects a common move parent only when targets share one", () => {
        expect(
            getMoveTargetsCommonParent({
                notes: [NOTES[0], NOTES[1]],
                entries: [],
                folderPaths: [],
            }),
        ).toBe("notes");
        expect(
            getMoveTargetsCommonParent({
                notes: [NOTES[0]],
                entries: [ENTRY],
                folderPaths: [],
            }),
        ).toBe(null);
    });
});
