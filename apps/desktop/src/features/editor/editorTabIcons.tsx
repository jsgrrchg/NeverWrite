import type { ReactNode } from "react";
import type { Tab } from "../../app/store/editorStore";

export function renderEditorTabLeadingIcon(tab: Tab): ReactNode {
    if (tab.kind === "pdf") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-65"
            >
                <path
                    d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                    stroke="#e24b3b"
                    strokeWidth="1"
                />
                <path
                    d="M9.5 1.5V5H13"
                    stroke="#e24b3b"
                    strokeWidth="0.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <text
                    x="5"
                    y="12"
                    fontSize="4.5"
                    fontWeight="700"
                    fill="#e24b3b"
                    fontFamily="sans-serif"
                >
                    PDF
                </text>
            </svg>
        );
    }

    if (tab.kind === "file") {
        if (tab.mimeType?.startsWith("image/")) {
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
                        y="2.5"
                        width="12"
                        height="11"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1"
                    />
                    <circle
                        cx="5.5"
                        cy="5.8"
                        r="1.2"
                        stroke="currentColor"
                        strokeWidth="0.8"
                    />
                    <path
                        d="M2.5 11l3-3.5 2.5 2.5 1.5-1.5 4 3.5"
                        stroke="currentColor"
                        strokeWidth="0.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            );
        }
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <path
                    d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <path
                    d="M9.5 1.5V5H13"
                    stroke="currentColor"
                    strokeWidth="0.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        );
    }

    if (tab.kind === "ai-review") {
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
