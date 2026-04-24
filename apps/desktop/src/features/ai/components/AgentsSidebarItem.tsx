import { type MouseEvent as ReactMouseEvent } from "react";
import type { AIChatSession } from "../types";

// Comando-style session row for the left sidebar Agents panel. Presentational
// only — all derived values (title, preview, runtime label, timestamp,
// activity indicator) are computed by the parent so the item stays dumb and
// cheap to memoize.

export type AgentsSidebarActivityIndicator = {
    readonly tone: "working" | "danger";
    readonly title: string;
} | null;

export interface AgentsSidebarItemMetrics {
    rowPaddingX: number;
    rowPaddingY: number;
    rowGap: number;
    inlineGap: number;
    titleFontSize: number;
    previewFontSize: number;
    metaFontSize: number;
    timestampFontSize: number;
    indicatorFontSize: number;
    pinButtonSize: number;
    pinIconSize: number;
}

export interface AgentsSidebarItemProps {
    session: AIChatSession;
    title: string;
    preview: string;
    runtimeLabel: string;
    messageCount: number;
    timestampLabel: string;
    isActive: boolean;
    isPinned: boolean;
    indicator: AgentsSidebarActivityIndicator;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (value: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    renameInputRef: React.RefObject<HTMLInputElement | null>;
    onOpen: () => void;
    onStartRename: () => void;
    onTogglePin: () => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    metrics: AgentsSidebarItemMetrics;
}

export function AgentsSidebarItem({
    title,
    preview,
    runtimeLabel,
    messageCount,
    timestampLabel,
    isActive,
    isPinned,
    indicator,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    renameInputRef,
    onOpen,
    onStartRename,
    onTogglePin,
    onContextMenu,
    metrics,
}: AgentsSidebarItemProps) {
    return (
        <div
            role="option"
            aria-selected={isActive}
            tabIndex={0}
            className="group flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5"
            style={{
                gap: metrics.rowGap,
                padding: `${metrics.rowPaddingY}px ${metrics.rowPaddingX}px`,
                backgroundColor: isActive
                    ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                    : "transparent",
                borderLeft: `2px solid ${
                    isActive
                        ? "var(--accent)"
                        : "transparent"
                }`,
                transition:
                    "background-color 100ms ease, border-color 100ms ease",
            }}
            onClick={() => {
                if (isRenaming) return;
                onOpen();
            }}
            onDoubleClick={(event) => {
                if (isRenaming) return;
                event.preventDefault();
                onStartRename();
            }}
            onContextMenu={onContextMenu}
            onMouseEnter={(event) => {
                if (isActive) return;
                event.currentTarget.style.backgroundColor =
                    "color-mix(in srgb, var(--bg-tertiary) 65%, transparent)";
            }}
            onMouseLeave={(event) => {
                if (isActive) return;
                event.currentTarget.style.backgroundColor = "transparent";
            }}
        >
            <div
                className="flex min-w-0 items-center"
                style={{ gap: metrics.inlineGap }}
            >
                {indicator ? (
                    <span
                        aria-hidden
                        title={indicator.title}
                        className="shrink-0 leading-none"
                        style={{
                            fontSize: metrics.indicatorFontSize,
                            color:
                                indicator.tone === "danger"
                                    ? "var(--diff-remove, #f43f5e)"
                                    : "var(--diff-warn, #d97706)",
                        }}
                    >
                        ●
                    </span>
                ) : null}

                {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        autoFocus
                        className="min-w-0 flex-1 rounded px-1 py-0.5 text-[11.5px] font-medium outline-none"
                        style={{
                            background: "var(--bg-primary)",
                            color: "var(--text-primary)",
                            border: "1px solid var(--accent)",
                            fontSize: metrics.titleFontSize,
                        }}
                        value={renameValue}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onRenameChange(event.target.value)}
                        onBlur={onRenameCommit}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                                event.preventDefault();
                                onRenameCommit();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                onRenameCancel();
                            }
                        }}
                    />
                ) : (
                    <span
                        className="min-w-0 flex-1 truncate text-[11.5px] font-medium"
                        style={{
                            color: "var(--text-primary)",
                            fontSize: metrics.titleFontSize,
                        }}
                    >
                        {title}
                    </span>
                )}

                <button
                    type="button"
                    title={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    aria-label={
                        isPinned ? "Unpin from sidebar" : "Pin to sidebar"
                    }
                    onClick={(event) => {
                        event.stopPropagation();
                        onTogglePin();
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity"
                    style={{
                        width: metrics.pinButtonSize,
                        height: metrics.pinButtonSize,
                        color: isPinned
                            ? "var(--text-primary)"
                            : "var(--text-secondary)",
                        opacity: isPinned ? 1 : 0.55,
                    }}
                >
                    <svg
                        width={metrics.pinIconSize}
                        height={metrics.pinIconSize}
                        viewBox="0 0 24 24"
                        fill={isPinned ? "currentColor" : "none"}
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z" />
                        <path d="M12 15v6" />
                    </svg>
                </button>

                <span
                    className="shrink-0 text-[10px]"
                    style={{
                        fontSize: metrics.timestampFontSize,
                        color:
                            indicator?.tone === "danger"
                                ? "var(--diff-remove, #f43f5e)"
                                : indicator?.tone === "working"
                                  ? "var(--diff-warn, #d97706)"
                                  : "var(--text-secondary)",
                        opacity: 0.85,
                    }}
                >
                    {timestampLabel}
                </span>
            </div>

            {preview ? (
                <p
                    className="line-clamp-1 text-[10.5px] leading-[1.35]"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: metrics.previewFontSize,
                    }}
                >
                    {preview}
                </p>
            ) : null}

            <div
                className="flex items-center gap-1 text-[10px]"
                style={{
                    color: "var(--text-secondary)",
                    fontSize: metrics.metaFontSize,
                }}
            >
                <span>{runtimeLabel}</span>
                {messageCount > 0 ? (
                    <>
                        <span>·</span>
                        <span>
                            {messageCount === 1
                                ? "1 message"
                                : `${messageCount} messages`}
                        </span>
                    </>
                ) : null}
            </div>
        </div>
    );
}
