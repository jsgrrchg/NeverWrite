import type { MouseEventHandler } from "react";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { FolderTypeIcon } from "../../../components/icons/FolderTypeIcon";
import { ChatInlinePill } from "./ChatInlinePill";
import type { ChatPillMetrics } from "./chatPillMetrics";

export type ChatVaultReferenceKind = "file" | "folder" | "note";

function referenceIconSize(metrics: ChatPillMetrics) {
    return Math.max(11, Math.min(14, metrics.fontSize));
}

export function ChatVaultReference({
    interactive = false,
    kind,
    label,
    metrics,
    mimeType,
    onClick,
    onContextMenu,
    path,
    title,
}: {
    interactive?: boolean;
    kind: ChatVaultReferenceKind;
    label: string;
    metrics: ChatPillMetrics;
    mimeType?: string | null;
    onClick?: () => void;
    onContextMenu?: MouseEventHandler<HTMLElement>;
    path: string;
    title?: string;
}) {
    const size = referenceIconSize(metrics);
    const leadingVisual =
        kind === "folder" ? (
            <FolderTypeIcon
                folderName={path}
                opacity={1}
                open={false}
                size={size}
            />
        ) : (
            <FileTypeIcon
                fileName={
                    kind === "note" && !/\.md$/i.test(path)
                        ? `${path}.md`
                        : path
                }
                kind={kind === "note" ? "note" : undefined}
                mimeType={mimeType}
                opacity={1}
                size={size}
            />
        );

    return (
        <ChatInlinePill
            appearance="link"
            interactive={interactive}
            label={label}
            leadingVisual={leadingVisual}
            metrics={metrics}
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title ?? path}
            variant={
                kind === "folder"
                    ? "folder"
                    : kind === "file"
                      ? "file"
                      : "accent"
            }
        />
    );
}
