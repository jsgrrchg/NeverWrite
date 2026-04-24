import type { ReactNode } from "react";
import type { Tab } from "../../app/store/editorStore";
import { FileTypeIcon } from "../../components/icons/FileTypeIcon";
import type { AIChatSession } from "../ai/types";

type TabIconSessionLookup = Record<
    string,
    Pick<AIChatSession, "runtimeId"> | undefined
>;

function getTabRuntimeId(
    tab: Tab,
    sessionsById?: TabIconSessionLookup,
): string | null {
    if (tab.kind !== "ai-chat" && tab.kind !== "ai-review") {
        return null;
    }

    return sessionsById?.[tab.sessionId]?.runtimeId ?? null;
}

function ChatProviderIcon({ runtimeId }: { readonly runtimeId: string }) {
    if (runtimeId.includes("claude")) {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <line strokeWidth="1.35" x1="8" x2="8" y1="2" y2="14" />
                <line strokeWidth="1.35" x1="2" x2="14" y1="8" y2="8" />
                <line
                    strokeWidth="1.35"
                    x1="3.75"
                    x2="12.25"
                    y1="3.75"
                    y2="12.25"
                />
                <line
                    strokeWidth="1.35"
                    x1="12.25"
                    x2="3.75"
                    y1="3.75"
                    y2="12.25"
                />
            </svg>
        );
    }

    if (runtimeId.includes("codex")) {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <polygon
                    points="8,2.3 13.4,5.4 13.4,10.6 8,13.7 2.6,10.6 2.6,5.4"
                    strokeWidth="1.1"
                />
                <line strokeWidth="1" x1="8" x2="8" y1="2.3" y2="13.7" />
                <line strokeWidth="1" x1="2.6" x2="13.4" y1="5.4" y2="10.6" />
                <line strokeWidth="1" x1="13.4" x2="2.6" y1="5.4" y2="10.6" />
            </svg>
        );
    }

    if (runtimeId.includes("gemini")) {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="currentColor"
                height={12}
                viewBox="0 0 16 16"
                width={12}
            >
                <path d="M8 1.2c.25 3.55 1.6 5.35 6.8 6.8-5.2 1.45-6.55 3.25-6.8 6.8-.25-3.55-1.6-5.35-6.8-6.8C6.4 6.55 7.75 4.75 8 1.2Z" />
            </svg>
        );
    }

    return (
        <svg
            className="shrink-0 opacity-55"
            fill="none"
            height={12}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 16 16"
            width={12}
        >
            <line strokeWidth="1.5" x1="4.75" x2="4.75" y1="2.75" y2="13.25" />
            <line strokeWidth="1.5" x1="4.75" x2="11.25" y1="8" y2="2.75" />
            <line strokeWidth="1.5" x1="4.75" x2="11.25" y1="8" y2="13.25" />
        </svg>
    );
}

export function renderEditorTabLeadingIcon(
    tab: Tab,
    sessionsById?: TabIconSessionLookup,
): ReactNode {
    if (tab.kind === "note") {
        return (
            <FileTypeIcon
                className="shrink-0"
                fileName={tab.title}
                kind="note"
                opacity={0.55}
                size={12}
            />
        );
    }

    if (tab.kind === "pdf") {
        return (
            <FileTypeIcon
                className="shrink-0 opacity-65"
                fileName={tab.title}
                kind="pdf"
                opacity={0.65}
                size={12}
            />
        );
    }

    if (tab.kind === "file") {
        return (
            <FileTypeIcon
                className="shrink-0 opacity-55"
                fileName={tab.path || tab.title}
                kind="file"
                mimeType={tab.mimeType}
                opacity={0.55}
                size={12}
            />
        );
    }

    if (tab.kind === "ai-review") {
        const runtimeId = getTabRuntimeId(tab, sessionsById);
        if (runtimeId) {
            return <ChatProviderIcon runtimeId={runtimeId} />;
        }

        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 opacity-60"
            >
                <path d="M3 8h10M6 4l-4 4 4 4M10 4l4 4-4 4" />
            </svg>
        );
    }

    if (tab.kind === "ai-chat") {
        const runtimeId = getTabRuntimeId(tab, sessionsById);
        if (runtimeId) {
            return <ChatProviderIcon runtimeId={runtimeId} />;
        }

        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 opacity-60"
            >
                <path d="M2 3h12v8H5l-3 3V3z" />
            </svg>
        );
    }

    if (tab.kind === "ai-chat-history") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.15"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 opacity-60"
            >
                <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />
                <path d="M8 5.2v3.1l2.1 1.2" />
                <path d="M8 1.6v1.2M12.7 3.3l-.9.9" />
            </svg>
        );
    }

    if (tab.kind === "map") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <rect
                    x="2"
                    y="2"
                    width="12"
                    height="12"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <circle cx="8" cy="5.5" r="1.3" fill="currentColor" />
                <circle cx="5" cy="10.5" r="1.3" fill="currentColor" />
                <circle cx="11" cy="10.5" r="1.3" fill="currentColor" />
                <path
                    d="M7.15 6.65 5.7 9.3M8.85 6.65l1.45 2.65"
                    stroke="currentColor"
                    strokeWidth="0.85"
                    strokeLinecap="round"
                />
            </svg>
        );
    }

    if (tab.kind === "graph") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="2"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <circle
                    cx="3"
                    cy="4"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="13"
                    cy="4"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="4"
                    cy="13"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="12"
                    cy="12"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <path
                    d="M6.3 6.8l-2-1.8M9.7 6.8l2-1.8M6.5 9.5l-1.5 2.5M9.5 9.5l1.5 1.5"
                    stroke="currentColor"
                    strokeWidth="0.7"
                    strokeLinecap="round"
                />
            </svg>
        );
    }

    if (tab.kind === "terminal") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.15"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 opacity-60"
            >
                <path d="M2.5 3.5h11v9h-11z" />
                <path d="m5 6 2 2-2 2" />
                <path d="M8.5 10h2.5" />
            </svg>
        );
    }

    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="shrink-0 opacity-50"
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M6 8h4M6 10.5h3"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
            />
        </svg>
    );
}
