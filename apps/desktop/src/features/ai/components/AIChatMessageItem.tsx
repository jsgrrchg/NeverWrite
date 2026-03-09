import { useState } from "react";
import type { AIChatMessage } from "../types";
import { MarkdownContent } from "./MarkdownContent";

interface AIChatMessageItemProps {
    message: AIChatMessage;
    isLast?: boolean;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}

function stripMarkdownBold(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

function ThinkingMessage({ message }: { message: AIChatMessage }) {
    const [expanded, setExpanded] = useState(false);
    const content = stripMarkdownBold(message.content).trim();

    return (
        <div>
            <button
                type="button"
                onClick={() => {
                    if (!message.inProgress && content) setExpanded((v) => !v);
                }}
                className="flex items-center gap-2 py-0.5 text-xs"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    cursor: message.inProgress || !content ? "default" : "pointer",
                    opacity: 0.7,
                }}
            >
                {message.inProgress ? (
                    <span
                        className="inline-block h-3 w-3 animate-spin rounded-full"
                        style={{
                            border: "1.5px solid var(--text-secondary)",
                            borderTopColor: "var(--accent)",
                        }}
                    />
                ) : (
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            transform: expanded ? "rotate(90deg)" : "none",
                            transition: "transform 0.12s ease",
                        }}
                    >
                        <path d="M4.5 2.5L8 6L4.5 9.5" />
                    </svg>
                )}
                <span>Thinking{message.inProgress ? "..." : ""}</span>
            </button>
            {expanded && content && (
                <div
                    className="mt-1 whitespace-pre-wrap pl-5 text-xs italic"
                    style={{ color: "var(--text-secondary)", opacity: 0.7 }}
                >
                    {content}
                </div>
            )}
        </div>
    );
}

function ToolIcon({ kind }: { kind?: string }) {
    const k = String(kind ?? "");
    if (k === "read" || k === "search") {
        return (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5.5" cy="5.5" r="3" />
                <path d="M7.5 7.5L10 10" />
            </svg>
        );
    }
    if (k === "edit") {
        return (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 2l3 3-7 7H0V9z" />
            </svg>
        );
    }
    if (k === "execute") {
        return (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3l4 3-4 3z" />
                <path d="M7 9h3" />
            </svg>
        );
    }
    // default gear
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="1.5" />
            <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1" />
        </svg>
    );
}

function ToolMessage({ message }: { message: AIChatMessage }) {
    const toolKind = String(message.meta?.tool ?? "");
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const label = shortTarget ?? message.title ?? message.content;
    const status = String(message.meta?.status ?? "");
    const isCompleted = status === "completed";

    return (
        <div
            className="flex items-center gap-2 py-0.5 text-xs"
            style={{
                color: "var(--text-secondary)",
                opacity: isCompleted ? 0.45 : 0.7,
            }}
        >
            <ToolIcon kind={toolKind} />
            <span className="truncate">{label}</span>
            {!isCompleted && status === "in_progress" ? (
                <span
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                    style={{ backgroundColor: "var(--accent)" }}
                />
            ) : null}
        </div>
    );
}

function ErrorMessage({ message }: { message: AIChatMessage }) {
    return (
        <div
            className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs"
            style={{
                color: "#fca5a5",
                backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
            }}
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0"
                style={{ color: "#f87171" }}
            >
                <circle cx="7" cy="7" r="5.5" />
                <path d="M7 4.5v3M7 9.5h.005" />
            </svg>
            <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
    );
}

function PermissionMessage({
    message,
    onPermissionResponse,
}: {
    message: AIChatMessage;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}) {
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;

    return (
        <div
            className="rounded-lg px-2.5 py-2"
            style={{
                border: "1px solid color-mix(in srgb, #d97706 30%, var(--border))",
                backgroundColor: "color-mix(in srgb, #d97706 6%, transparent)",
            }}
        >
            <div className="text-xs" style={{ color: "var(--text-primary)" }}>
                {message.content}
            </div>
            {shortTarget ? (
                <div
                    className="mt-1 truncate text-[11px]"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {shortTarget}
                </div>
            ) : null}
            {message.permissionRequestId && message.permissionOptions?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                    {message.permissionOptions.map((option) => (
                        <button
                            key={option.option_id}
                            type="button"
                            onClick={() =>
                                onPermissionResponse?.(
                                    message.permissionRequestId!,
                                    option.option_id,
                                )
                            }
                            className="rounded-full px-3 py-1 text-xs"
                            style={{
                                color: option.kind.startsWith("reject")
                                    ? "#fecaca"
                                    : "#fff",
                                backgroundColor: option.kind.startsWith("reject")
                                    ? "color-mix(in srgb, #dc2626 35%, transparent)"
                                    : "var(--accent)",
                                border: "none",
                            }}
                        >
                            {option.name}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function ProposedEditMessage({ message }: { message: AIChatMessage }) {
    const label = message.title ?? message.kind.replaceAll("_", " ");

    return (
        <div
            className="rounded-lg px-2.5 py-2"
            style={{
                border: "1px solid color-mix(in srgb, #0891b2 30%, var(--border))",
                backgroundColor: "color-mix(in srgb, #0891b2 6%, transparent)",
            }}
        >
            <div
                className="text-[11px] uppercase tracking-[0.14em]"
                style={{ color: "#0891b2" }}
            >
                {label}
            </div>
            <div
                className="mt-1 whitespace-pre-wrap text-xs"
                style={{ color: "var(--text-primary)" }}
            >
                {message.content}
            </div>
        </div>
    );
}

export function AIChatMessageItem({
    message,
    isLast,
    onPermissionResponse,
}: AIChatMessageItemProps) {
    // User text — full width, subtle box (Zed style)
    if (message.kind === "text" && message.role === "user") {
        return (
            <div
                className="whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
                style={{
                    color: "var(--text-primary)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border)",
                }}
            >
                {message.content}
            </div>
        );
    }

    // Thinking — collapsible single line
    if (message.kind === "thinking") {
        return <ThinkingMessage message={message} />;
    }

    // Tool activity — subtle one-liner
    if (message.kind === "tool") {
        return <ToolMessage message={message} />;
    }

    // Error — inline with icon
    if (message.kind === "error") {
        return <ErrorMessage message={message} />;
    }

    // Permission — minimal card
    if (message.kind === "permission") {
        return (
            <PermissionMessage
                message={message}
                onPermissionResponse={onPermissionResponse}
            />
        );
    }

    // Proposed edit / new note
    if (message.kind === "proposed_edit" || message.kind === "proposed_new_note") {
        return <ProposedEditMessage message={message} />;
    }

    // Assistant text — flat, no card
    return (
        <div className="text-sm" style={{ color: "var(--text-primary)" }}>
            <MarkdownContent content={message.content} />
            {message.inProgress && isLast ? (
                <span className="ml-1.5 inline-flex items-baseline gap-[3px]">
                    {[0, 1, 2].map((i) => (
                        <span
                            key={i}
                            className="inline-block h-[5px] w-[5px] rounded-full"
                            style={{
                                backgroundColor: "var(--accent)",
                                opacity: 0.6,
                                animation: `ai-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                            }}
                        />
                    ))}
                </span>
            ) : null}
        </div>
    );
}
