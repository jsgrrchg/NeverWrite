import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
} from "../ai/store/actionLogModel";
import { EditorChangeChrome } from "./EditorChangeChrome";

function makeTrackedFile(
    diffBase: string,
    currentText: string,
): TrackedFile {
    const linePatch = buildPatchFromTexts(diffBase, currentText);

    return {
        identityKey: "/vault/test.md",
        originPath: "/vault/test.md",
        path: "/vault/test.md",
        previousPath: null,
        status: { kind: "modified" },
        reviewState: "finalized",
        diffBase,
        currentText,
        unreviewedRanges: buildTextRangePatchFromTexts(
            diffBase,
            currentText,
            linePatch,
        ),
        unreviewedEdits: linePatch,
        version: 1,
        isText: true,
        updatedAt: 1,
    };
}

describe("EditorChangeChrome", () => {
    it("shows the Open review CTA for large diffs and uses the review action", () => {
        const openReview = vi.fn();
        const originalState = useEditorStore.getState();

        useEditorStore.setState({
            ...originalState,
            openReview,
        });

        try {
            const diffBase = Array.from({ length: 24 }, (_, index) =>
                `line-${index}`,
            ).join("\n");
            const currentText = Array.from({ length: 24 }, (_, index) =>
                index % 2 === 0 ? `changed-${index}` : `line-${index}`,
            ).join("\n");

            render(
                <EditorChangeChrome
                    trackedFile={makeTrackedFile(diffBase, currentText)}
                    sessionId="session-1"
                    view={null}
                />,
            );

            const cta = screen.getByRole("button", { name: "Open review" });
            fireEvent.click(cta);

            expect(openReview).toHaveBeenCalledWith("session-1", {
                title: "Review",
            });
        } finally {
            useEditorStore.setState({ ...originalState });
        }
    });
});
