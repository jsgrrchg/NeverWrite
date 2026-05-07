import type { CSSProperties } from "react";
import type { ChatPillMetrics } from "./chatPillMetrics";

type ComposerPillLayoutStyle = Pick<
    CSSProperties,
    | "maxWidth"
    | "overflow"
    | "overflowWrap"
    | "textOverflow"
    | "whiteSpace"
    | "wordBreak"
>;

export function getComposerPillLayoutStyle(
    metrics: ChatPillMetrics,
    options: { compact?: boolean } = {},
): ComposerPillLayoutStyle {
    if (options.compact === true) {
        return {
            maxWidth: `${metrics.maxWidth}px`,
            overflow: "hidden",
            overflowWrap: "normal",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            wordBreak: "normal",
        };
    }

    return {
        maxWidth: "100%",
        overflow: "visible",
        overflowWrap: "anywhere",
        textOverflow: "clip",
        whiteSpace: "normal",
        wordBreak: "break-word",
    };
}
