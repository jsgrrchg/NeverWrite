import { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";

import { resolveLinkHref } from "./livePreviewHelpers";
import { dispatchOpenYouTubeModal } from "../youtube";
import {
    createImageLivePreviewExtension,
    createTableLivePreviewExtension,
    type TableInteractionHandlers,
} from "./livePreviewBlocks";
import { createInlineLivePreviewPlugin } from "./livePreviewInline";
import { livePreviewTheme } from "./livePreviewTheme";

const INTERACTIVE_PREVIEW_SELECTOR = [
    ".cm-lp-link",
    ".cm-lp-task-line",
    ".cm-inline-image-link",
    ".cm-youtube-link",
    ".cm-note-embed",
    ".cm-lp-footnote-ref",
    ".cm-lp-table-link",
].join(", ");

function cycleTaskMarker(marker: string): string {
    return marker === "x" || marker === "X" ? " " : "x";
}

function collapsePreviewSelection(view: EditorView) {
    const selection = view.state.selection.main;
    if (!selection.empty) {
        view.dispatch({
            selection: { anchor: selection.head },
        });
    }

    const domSelection = view.dom.ownerDocument.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) return;
    if (domSelection.isCollapsed) return;

    const anchorNode = domSelection.anchorNode;
    const focusNode = domSelection.focusNode;
    const touchesEditor =
        (!!anchorNode && view.dom.contains(anchorNode)) ||
        (!!focusNode && view.dom.contains(focusNode));

    if (touchesEditor) {
        domSelection.removeAllRanges();
    }
}

function toggleTaskAtLine(view: EditorView, lineFrom: number, currentMarker: string) {
    const line = view.state.doc.lineAt(lineFrom);
    const match = line.text.match(
        /^(\s*(?:[-+*]|\d+[.)])\s+)\[( |x|X|~|\/)\]/,
    );
    if (!match) return false;

    const markerFrom = line.from + match[1].length + 1;
    const markerTo = markerFrom + 1;
    const nextMarker = cycleTaskMarker(currentMarker || match[2] || " ");
    view.dispatch({
        changes: { from: markerFrom, to: markerTo, insert: nextMarker },
    });
    view.focus();
    return true;
}

export function livePreviewExtension(
    vaultRoot: string | null,
    interactions: TableInteractionHandlers,
) {
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            if (target.closest(INTERACTIVE_PREVIEW_SELECTOR)) {
                event.preventDefault();
                collapsePreviewSelection(view);
                view.focus();
                return true;
            }

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
            collapsePreviewSelection(view);
            view.dispatch({ selection: { anchor: sourceFrom } });
            view.focus();
            return true;
        },
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            const taskLine = target.closest(".cm-lp-task-line") as HTMLElement | null;
            if (taskLine?.dataset.lpTaskFrom) {
                event.preventDefault();
                return toggleTaskAtLine(
                    view,
                    Number(taskLine.dataset.lpTaskFrom),
                    taskLine.dataset.lpTaskMarker ?? " ",
                );
            }

            const embed = target.closest(".cm-note-embed") as HTMLElement | null;
            if (embed?.dataset.wikilinkTarget) {
                event.preventDefault();
                interactions.navigateWikilink(embed.dataset.wikilinkTarget);
                return true;
            }

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

            const youtubeLink = target.closest(
                ".cm-youtube-link",
            ) as HTMLElement | null;
            if (youtubeLink?.dataset.href) {
                event.preventDefault();
                dispatchOpenYouTubeModal({
                    href: youtubeLink.dataset.href,
                    title: youtubeLink.dataset.title || "YouTube video",
                });
                return true;
            }

            const liveLink = target.closest(".cm-lp-link") as HTMLElement | null;
            if (liveLink?.dataset.href) {
                event.preventDefault();
                const noteTarget = interactions.getNoteLinkTarget(
                    liveLink.dataset.href,
                );
                if (noteTarget) {
                    interactions.navigateWikilink(noteTarget);
                    return true;
                }
                void openUrl(resolveLinkHref({ url: liveLink.dataset.href, label: null, isEmail: false }) ?? liveLink.dataset.href);
                return true;
            }

            const footnoteRef = target.closest(".cm-lp-footnote-ref") as HTMLElement | null;
            if (footnoteRef?.dataset.footnoteId) {
                const definition = view.dom.querySelector<HTMLElement>(
                    `.cm-lp-footnote-def[data-footnote-id="${CSS.escape(
                        footnoteRef.dataset.footnoteId,
                    )}"]`,
                );
                if (definition) {
                    event.preventDefault();
                    definition.scrollIntoView({ block: "nearest" });
                    return true;
                }
            }

            return false;
        },
        contextmenu(event: MouseEvent) {
            const target = event.target as HTMLElement;

            const liveLink = target.closest(".cm-lp-link") as HTMLElement | null;
            if (liveLink?.dataset.href) {
                event.preventDefault();
                interactions.openLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: liveLink.dataset.href,
                    noteTarget: interactions.getNoteLinkTarget(
                        liveLink.dataset.href,
                    ),
                });
                return true;
            }

            const linkedImage = target.closest(
                ".cm-inline-image-link",
            ) as HTMLElement | null;
            if (linkedImage?.dataset.href) {
                event.preventDefault();
                interactions.openLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: linkedImage.dataset.href,
                    noteTarget: null,
                });
                return true;
            }

            const tableUrl = target.closest(".cm-lp-table-url") as HTMLElement | null;
            if (tableUrl?.dataset.url) {
                event.preventDefault();
                interactions.openLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: tableUrl.dataset.url,
                    noteTarget: null,
                });
                return true;
            }

            return false;
        },
    });

    return [
        createInlineLivePreviewPlugin(),
        createImageLivePreviewExtension(vaultRoot),
        createTableLivePreviewExtension(interactions),
        clickHandler,
        livePreviewTheme,
    ];
}
