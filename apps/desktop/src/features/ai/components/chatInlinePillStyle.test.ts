import { describe, expect, it } from "vitest";
import {
    getChatInlineLeadingVisualStyle,
    getChatInlinePillStyle,
} from "./chatInlinePillStyle";

describe("getChatInlinePillStyle", () => {
    it("keeps wrapped reference labels left-aligned", () => {
        const style = getChatInlinePillStyle({
            appearance: "link",
            clickable: true,
            metrics: {
                fontSize: 12,
                gapX: 1,
                lineHeight: 1.4,
                maxWidth: 200,
                offsetY: 0,
                paddingX: 4,
                paddingY: 1,
                radius: 4,
            },
            variant: "accent",
        });

        expect(style.textAlign).toBe("left");
    });

    it("aligns leading visuals with the first label line", () => {
        const style = getChatInlineLeadingVisualStyle({
            fontSize: 12,
            gapX: 1,
            lineHeight: 1.4,
            maxWidth: 200,
            offsetY: 0,
            paddingX: 4,
            paddingY: 1,
            radius: 4,
        });

        expect(style).toMatchObject({
            alignItems: "center",
            display: "inline-flex",
            flexShrink: 0,
            height: "1.4em",
        });
    });
});
