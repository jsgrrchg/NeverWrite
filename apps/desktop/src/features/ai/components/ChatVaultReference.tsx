import type { MouseEventHandler } from "react";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { FolderTypeIcon } from "../../../components/icons/FolderTypeIcon";
import { ChatInlinePill } from "./ChatInlinePill";
import type { ChatPillMetrics } from "./chatPillMetrics";
import {
    getChatVaultReferenceLabel,
    parseChatVaultReferenceTarget,
} from "../chatVaultReferenceTarget";

export type ChatVaultReferenceKind = "file" | "folder" | "note";

function referenceIconSize(metrics: ChatPillMetrics) {
    return Math.max(11, Math.min(14, metrics.fontSize));
}

export function ChatVaultReference({
    interactive = false,
    kind,
    label,
    line,
    endLine,
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
    line?: number | null;
    endLine?: number | null;
    metrics: ChatPillMetrics;
    mimeType?: string | null;
    onClick?: () => void;
    onContextMenu?: MouseEventHandler<HTMLElement>;
    path: string;
    title?: string;
}) {
    const parsedTarget = parseChatVaultReferenceTarget(path);
    const target = {
        path: parsedTarget.path,
        line: line ?? parsedTarget.line,
        endLine: endLine ?? parsedTarget.endLine,
    };
    const size = referenceIconSize(metrics);
    const leadingVisual =
        kind === "folder" ? (
            <FolderTypeIcon
                folderName={target.path}
                opacity={1}
                open={false}
                size={size}
            />
        ) : (
            <FileTypeIcon
                fileName={
                    kind === "note" && !/\.md$/i.test(target.path)
                        ? `${target.path}.md`
                        : target.path
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
            label={getChatVaultReferenceLabel(label, target)}
            leadingVisual={leadingVisual}
            metrics={metrics}
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title ?? target.path}
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
