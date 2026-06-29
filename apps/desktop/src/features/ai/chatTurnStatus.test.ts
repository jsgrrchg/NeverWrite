import { describe, expect, it } from "vitest";
import type { AIChatSessionStatus } from "./types";
import { isCancellableChatTurnStatus } from "./chatTurnStatus";

describe("isCancellableChatTurnStatus", () => {
    it("matches chat turn statuses that can be stopped", () => {
        const cancellableStatuses: AIChatSessionStatus[] = [
            "streaming",
            "waiting_permission",
            "waiting_user_input",
        ];
        const nonCancellableStatuses: Array<
            AIChatSessionStatus | null | undefined
        > = ["idle", "review_required", "error", null, undefined];

        for (const status of cancellableStatuses) {
            expect(isCancellableChatTurnStatus(status)).toBe(true);
        }

        for (const status of nonCancellableStatuses) {
            expect(isCancellableChatTurnStatus(status)).toBe(false);
        }
    });
});
