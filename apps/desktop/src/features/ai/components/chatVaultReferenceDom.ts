import { createCatppuccinIconElement } from "../../../components/icons/catppuccinIconPresentation";
import { resolveCatppuccinFileIcon } from "../../../components/icons/fileTypeIcons";
import { resolveCatppuccinFolderIcon } from "../../../components/icons/folderTypeIcons";
import type { ChatVaultReferenceKind } from "./ChatVaultReference";
import { getChatInlinePillStyle } from "./chatInlinePillStyle";
import type { ChatPillMetrics } from "./chatPillMetrics";
import {
    getChatVaultReferenceLabel,
    parseChatVaultReferenceTarget,
} from "../chatVaultReferenceTarget";

function referenceIconSize(metrics: ChatPillMetrics) {
    return Math.max(11, Math.min(14, metrics.fontSize));
}

/** Applies the shared reference presentation to imperative composer nodes. */
export function presentComposerVaultReference(
    element: HTMLSpanElement,
    {
        interactive = false,
        kind,
        label,
        line,
        endLine,
        metrics,
        mimeType,
        path,
    }: {
        interactive?: boolean;
        kind: ChatVaultReferenceKind;
        label: string;
        line?: number | null;
        endLine?: number | null;
        metrics: ChatPillMetrics;
        mimeType?: string | null;
        path: string;
    },
) {
    const parsedTarget = parseChatVaultReferenceTarget(path);
    const target = {
        path: parsedTarget.path,
        line: line ?? parsedTarget.line,
        endLine: endLine ?? parsedTarget.endLine,
    };
    const variant =
        kind === "folder" ? "folder" : kind === "file" ? "file" : "accent";
    Object.assign(
        element.style,
        getChatInlinePillStyle({
            appearance: "link",
            clickable: interactive,
            metrics,
            variant,
        }),
    );

    const iconName =
        kind === "folder"
            ? resolveCatppuccinFolderIcon(target.path, false).iconName
            : resolveCatppuccinFileIcon(
                  kind === "note" && !/\.md$/i.test(target.path)
                      ? `${target.path}.md`
                      : target.path,
                  { kind: kind === "note" ? "note" : undefined, mimeType },
              ).iconName;
    const icon = createCatppuccinIconElement({
        iconName,
        opacity: 1,
        size: referenceIconSize(metrics),
    });
    const content = document.createElement("span");
    content.style.alignItems = "center";
    content.style.display = "inline-flex";
    content.style.gap = "4px";
    content.style.maxWidth = "100%";
    content.style.minWidth = "0";
    if (icon) content.append(icon);

    const labelElement = document.createElement("span");
    labelElement.textContent = getChatVaultReferenceLabel(label, target);
    labelElement.style.display = "block";
    labelElement.style.maxWidth = "100%";
    labelElement.style.minWidth = "0";
    labelElement.style.overflowWrap = "anywhere";
    labelElement.style.whiteSpace = "normal";
    labelElement.style.wordBreak = "break-word";
    content.append(labelElement);
    element.replaceChildren(content);
}
