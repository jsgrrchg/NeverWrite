import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIChatContextUsageBar } from "./AIChatContextUsageBar";

describe("AIChatContextUsageBar", () => {
    it("renders a progressbar with accessible usage details", () => {
        renderComponent(
            <AIChatContextUsageBar
                usage={{
                    session_id: "session-1",
                    used: 170_000,
                    size: 200_000,
                    cost: {
                        amount: 0.0421,
                        currency: "USD",
                    },
                    updatedAt: Date.now(),
                }}
            />,
        );

        const bar = screen.getByRole("progressbar", {
            name: /Context window 85% used/i,
        });
        expect(bar).toHaveAttribute("aria-valuenow", "85");
        expect(bar).toHaveAttribute("aria-valuemin", "0");
        expect(bar).toHaveAttribute("aria-valuemax", "100");
        expect(bar).toHaveAttribute(
            "title",
            expect.stringContaining("170k / 200k tokens"),
        );
        expect(bar).toHaveAttribute(
            "title",
            expect.stringContaining("Estimated cost:"),
        );
    });

    it("stays hidden when there is no valid usage payload", () => {
        const { container, rerender } = renderComponent(
            <AIChatContextUsageBar usage={null} />,
        );

        expect(container).toBeEmptyDOMElement();

        rerender(
            <AIChatContextUsageBar
                usage={{
                    session_id: "session-1",
                    used: 0,
                    size: 0,
                    updatedAt: Date.now(),
                }}
            />,
        );

        expect(container).toBeEmptyDOMElement();
    });
});
