import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReviewFileItem } from "../diff/editedFilesPresentationModel";
import { useEditedFilesReviewExpansion } from "./useEditedFilesReviewExpansion";

function makeItem(identityKey: string): ReviewFileItem {
    return {
        file: {
            identityKey,
        },
    } as ReviewFileItem;
}

describe("useEditedFilesReviewExpansion", () => {
    it("keeps manual expansion state when items are rerendered with the same keys", () => {
        const { result, rerender } = renderHook(
            ({ items }: { items: ReviewFileItem[] }) =>
                useEditedFilesReviewExpansion(items),
            {
                initialProps: {
                    items: [makeItem("alpha"), makeItem("beta")],
                },
            },
        );

        expect(Array.from(result.current.expandedKeys)).toEqual([
            "alpha",
            "beta",
        ]);

        act(() => {
            result.current.toggleFile("alpha");
        });

        expect(Array.from(result.current.expandedKeys)).toEqual(["beta"]);

        rerender({
            items: [makeItem("alpha"), makeItem("beta")],
        });

        expect(Array.from(result.current.expandedKeys)).toEqual(["beta"]);
    });
});
