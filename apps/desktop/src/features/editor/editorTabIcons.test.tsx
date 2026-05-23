import { describe, expect, it } from "vitest";
import type { Tab } from "../../app/store/editorStore";
import { renderComponent } from "../../test/test-utils";
import { renderEditorTabLeadingIcon } from "./editorTabIcons";

describe("renderEditorTabLeadingIcon", () => {
    it("uses the official OpenCode logo shape for OpenCode chat tabs", () => {
        const tab: Tab = {
            id: "chat-opencode",
            kind: "ai-chat",
            sessionId: "session-opencode",
            title: "OpenCode",
        };

        const { container } = renderComponent(
            <>
                {renderEditorTabLeadingIcon(tab, {
                    "session-opencode": { runtimeId: "opencode-acp" },
                })}
            </>,
        );

        const svg = container.querySelector("svg");
        const pathData = Array.from(svg?.querySelectorAll("path") ?? []).map(
            (path) => path.getAttribute("d"),
        );

        expect(svg?.getAttribute("viewBox")).toBe("0 0 300 300");
        expect(pathData).toContain("M210 240H90V120H210V240Z");
        expect(pathData).toContain(
            "M210 60H90V240H210V60ZM270 300H30V0H270V300Z",
        );
        expect(svg?.querySelector("line")).toBeNull();
    });
});
