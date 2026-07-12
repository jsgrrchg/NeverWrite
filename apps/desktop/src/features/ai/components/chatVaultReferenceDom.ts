import { createCatppuccinIconElement } from "../../../components/icons/catppuccinIconPresentation";
import { resolveCatppuccinFileIcon } from "../../../components/icons/fileTypeIcons";
import { resolveCatppuccinFolderIcon } from "../../../components/icons/folderTypeIcons";
import type { ChatVaultReferenceKind } from "./ChatVaultReference";
import { getChatInlinePillStyle } from "./chatInlinePillStyle";
import type { ChatPillMetrics } from "./chatPillMetrics";

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
        metrics,
        mimeType,
        path,
    }: {
        interactive?: boolean;
        kind: ChatVaultReferenceKind;
        label: string;
        metrics: ChatPillMetrics;
        mimeType?: string | null;
        path: string;
    },
) {
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
            ? resolveCatppuccinFolderIcon(path, false).iconName
            : resolveCatppuccinFileIcon(
                  kind === "note" && !/\.md$/i.test(path) ? `${path}.md` : path,
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
    labelElement.textContent = label;
    labelElement.style.display = "block";
    labelElement.style.maxWidth = "100%";
    labelElement.style.minWidth = "0";
    labelElement.style.overflowWrap = "anywhere";
    labelElement.style.whiteSpace = "normal";
    labelElement.style.wordBreak = "break-word";
    content.append(labelElement);
    element.replaceChildren(content);
}
