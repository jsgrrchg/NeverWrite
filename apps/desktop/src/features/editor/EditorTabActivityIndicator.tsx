import type { ReactNode } from "react";
import type { Tab } from "../../app/store/editorStore";
import { resolveAgentSessionActivity } from "../ai/agentSessionActivity";
import type { AIChatSession } from "../ai/types";

type TabActivitySessionLookup = Record<
    string,
    Pick<AIChatSession, "runtimeState" | "status"> | undefined
>;

function getAgentSessionId(tab: Tab): string | null {
    if (tab.kind === "ai-chat" || tab.kind === "ai-review") {
        return tab.sessionId;
    }

    return null;
}

export function renderEditorTabActivityIndicator(
    tab: Tab,
    sessionsById?: TabActivitySessionLookup,
): ReactNode {
    const sessionId = getAgentSessionId(tab);
    if (!sessionId) {
        return null;
    }

    const activityIndicator = resolveAgentSessionActivity(
        sessionsById?.[sessionId] ?? null,
    );
    if (!activityIndicator) {
        return null;
    }

    return (
        <span
            aria-hidden="true"
            className="shrink-0"
            style={{
                fontSize: 9,
                lineHeight: 1,
                color:
                    activityIndicator.tone === "danger"
                        ? "var(--diff-remove)"
                        : "var(--diff-warn)",
            }}
            title={activityIndicator.title}
        >
            ●
        </span>
    );
}
