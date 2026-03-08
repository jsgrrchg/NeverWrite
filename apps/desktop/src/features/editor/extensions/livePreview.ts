import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { openUrl } from "@tauri-apps/plugin-opener";

import { findAncestor, parseLinkChildren } from "./livePreviewHelpers";
import {
    createImageLivePreviewPlugin,
    createTableLivePreviewExtension,
    type TableInteractionHandlers,
} from "./livePreviewBlocks";
import { createInlineLivePreviewPlugin } from "./livePreviewInline";
import { livePreviewTheme } from "./livePreviewTheme";

export function livePreviewExtension(
    vaultRoot: string | null,
    interactions: TableInteractionHandlers,
) {
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            if (target.closest(".cm-lp-table-link")) return false;
            const tableCell = target.closest(
                ".cm-lp-table-cell",
            ) as HTMLElement | null;
            const tableWidget = target.closest(
                ".cm-lp-table-widget",
            ) as HTMLElement | null;

            const sourceFromRaw =
                tableCell?.dataset.sourceFrom ?? tableWidget?.dataset.sourceFrom;
            if (!sourceFromRaw) return false;

            const sourceFrom = Number(sourceFromRaw);
            if (!Number.isFinite(sourceFrom)) return false;

            event.preventDefault();
            view.dispatch({ selection: { anchor: sourceFrom } });
            view.focus();
            return true;
        },
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            const tableWikilink = target.closest(
                ".cm-lp-table-wikilink",
            ) as HTMLElement | null;
            if (tableWikilink?.dataset.wikilinkTarget) {
                event.preventDefault();
                interactions.navigateWikilink(tableWikilink.dataset.wikilinkTarget);
                return true;
            }

            const tableUrl = target.closest(".cm-lp-table-url") as HTMLElement | null;
            if (tableUrl?.dataset.url) {
                event.preventDefault();
                void openUrl(tableUrl.dataset.url);
                return true;
            }

            const linkedImage = target.closest(
                ".cm-inline-image-link",
            ) as HTMLElement | null;

            if (linkedImage?.dataset.href) {
                event.preventDefault();
                void openUrl(linkedImage.dataset.href);
                return true;
            }

            if (!target.closest(".cm-lp-link")) return false;

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            if (pos === null) return false;

            const resolved = syntaxTree(view.state).resolveInner(pos, -1);
            const linkNode = findAncestor(resolved, "Link");
            if (!linkNode) return false;

            const info = parseLinkChildren(linkNode, view.state);
            if (!info?.url) return false;

            event.preventDefault();
            void openUrl(info.url);
            return true;
        },
    });

    return [
        createInlineLivePreviewPlugin(),
        createImageLivePreviewPlugin(vaultRoot),
        createTableLivePreviewExtension(interactions),
        clickHandler,
        livePreviewTheme,
    ];
}
