import { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";

import { resolveLinkHref, linkReferenceField } from "./livePreviewHelpers";
import { dispatchOpenYouTubeModal } from "../youtube";
import {
    createCodeBlockLivePreviewExtension,
    createImageLivePreviewExtension,
    createImageResizeExtension,
    createTableLivePreviewExtension,
    type TableInteractionHandlers,
} from "./livePreviewBlocks";
import { createInlineLivePreviewPlugin } from "./livePreviewInline";
import { livePreviewTheme } from "./livePreviewTheme";

const TASK_TOGGLE_MARKER_WIDTH_EM = 1.2;
const TASK_TOGGLE_SIZE_EM = 0.92;
const TASK_TOGGLE_GAP_EM = 0.65;

const POINTER_INTERACTIVE_PREVIEW_SELECTOR = [
    ".cm-lp-link",
    ".cm-inline-image-link",
    ".cm-youtube-link",
    ".cm-note-embed",
    ".cm-lp-footnote-ref",
    ".cm-lp-table-link",
].join(", ");

const KEYBOARD_INTERACTIVE_PREVIEW_SELECTOR = [
    POINTER_INTERACTIVE_PREVIEW_SELECTOR,
    ".cm-lp-task-line",
].join(", ");

function cycleTaskMarker(marker: string): string {
    return marker === "x" || marker === "X" ? " " : "x";
}

function getTaskToggleMetrics(taskLine: HTMLElement) {
    const rect = taskLine.getBoundingClientRect();
    const style =
        taskLine.ownerDocument.defaultView?.getComputedStyle(taskLine);
    const fontSize = Number.parseFloat(style?.fontSize ?? "");
    const lineHeight = Number.parseFloat(style?.lineHeight ?? "");
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "");
    const paddingTop = Number.parseFloat(style?.paddingTop ?? "");

    if (
        !Number.isFinite(fontSize) ||
        fontSize <= 0 ||
        !Number.isFinite(lineHeight) ||
        lineHeight <= 0 ||
        !Number.isFinite(paddingLeft) ||
        paddingLeft <= 0 ||
        !Number.isFinite(paddingTop) ||
        paddingTop < 0
    ) {
        return null;
    }

    const checkboxSize = fontSize * TASK_TOGGLE_SIZE_EM;
    const markerWidth = fontSize * TASK_TOGGLE_MARKER_WIDTH_EM;
    const markerGap = fontSize * TASK_TOGGLE_GAP_EM;
    const checkboxLeft =
        rect.left +
        Math.max(
            0,
            paddingLeft - markerGap - markerWidth / 2 - checkboxSize / 2,
        );
    const checkboxTop =
        rect.top + paddingTop + Math.max(0, (lineHeight - checkboxSize) / 2);

    return {
        left: checkboxLeft,
        right: checkboxLeft + checkboxSize,
        top: checkboxTop,
        bottom: checkboxTop + checkboxSize,
    };
}

export function isPointerInsideTaskToggleZone(
    taskLine: HTMLElement,
    clientX: number,
    clientY: number,
): boolean {
    const metrics = getTaskToggleMetrics(taskLine);
    if (!metrics) return false;

    return (
        clientX >= metrics.left &&
        clientX <= metrics.right &&
        clientY >= metrics.top &&
        clientY <= metrics.bottom
    );
}

function getTaskLinePointerTarget(
    target: HTMLElement,
    clientX: number,
    clientY: number,
): HTMLElement | null {
    const taskLine = target.closest(".cm-lp-task-line") as HTMLElement | null;
    if (!taskLine?.dataset.lpTaskFrom) return null;
    return isPointerInsideTaskToggleZone(taskLine, clientX, clientY)
        ? taskLine
        : null;
}

export function getBlockWidgetSelectionAnchor(
    widget: HTMLElement,
    clientY: number,
): number | null {
    const sourceFrom = Number(widget.dataset.sourceFrom ?? "");
    const sourceTo = Number(widget.dataset.sourceTo ?? "");
    if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
        return null;
    }

    const rect = widget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    return clientY <= midpoint ? sourceFrom : sourceTo;
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

function toggleTaskAtLine(
    view: EditorView,
    lineFrom: number,
    currentMarker: string,
) {
    const line = view.state.doc.lineAt(lineFrom);
    const match = line.text.match(/^(\s*(?:[-+*]|\d+[.)])\s+)\[( |x|X|~|\/)\]/);
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

function activateTaskLine(taskLine: HTMLElement, view: EditorView) {
    if (!taskLine.dataset.lpTaskFrom) return false;

    return toggleTaskAtLine(
        view,
        Number(taskLine.dataset.lpTaskFrom),
        taskLine.dataset.lpTaskMarker ?? " ",
    );
}

function activateInteractivePreview(
    target: HTMLElement,
    view: EditorView,
    interactions: TableInteractionHandlers,
) {
    const embed = target.closest(".cm-note-embed") as HTMLElement | null;
    if (embed?.dataset.wikilinkTarget) {
        interactions.navigateWikilink(embed.dataset.wikilinkTarget);
        return true;
    }

    const tableWikilink = target.closest(
        ".cm-lp-table-wikilink",
    ) as HTMLElement | null;
    if (tableWikilink?.dataset.wikilinkTarget) {
        interactions.navigateWikilink(tableWikilink.dataset.wikilinkTarget);
        return true;
    }

    const tableUrl = target.closest(".cm-lp-table-url") as HTMLElement | null;
    if (tableUrl?.dataset.url) {
        void openUrl(tableUrl.dataset.url);
        return true;
    }

    const linkedImage = target.closest(
        ".cm-inline-image-link",
    ) as HTMLElement | null;
    if (linkedImage?.dataset.href) {
        void openUrl(linkedImage.dataset.href);
        return true;
    }

    const youtubeLink = target.closest(
        ".cm-youtube-link",
    ) as HTMLElement | null;
    if (youtubeLink?.dataset.href) {
        dispatchOpenYouTubeModal({
            href: youtubeLink.dataset.href,
            title: youtubeLink.dataset.title || "YouTube video",
        });
        return true;
    }

    const liveLink = target.closest(".cm-lp-link") as HTMLElement | null;
    if (liveLink?.dataset.href) {
        const noteTarget = interactions.getNoteLinkTarget(
            liveLink.dataset.href,
        );
        if (noteTarget) {
            interactions.navigateWikilink(noteTarget);
            return true;
        }
        void openUrl(
            resolveLinkHref({
                url: liveLink.dataset.href,
                label: null,
                isEmail: false,
            }) ?? liveLink.dataset.href,
        );
        return true;
    }

    const footnoteRef = target.closest(
        ".cm-lp-footnote-ref",
    ) as HTMLElement | null;
    if (footnoteRef?.dataset.footnoteId) {
        const definition = view.dom.querySelector<HTMLElement>(
            `.cm-lp-footnote-def[data-footnote-id="${CSS.escape(
                footnoteRef.dataset.footnoteId,
            )}"]`,
        );
        if (!definition) return false;
        definition.scrollIntoView({ block: "nearest" });
        return true;
    }

    return false;
}

function openInteractivePreviewContextMenu(
    target: HTMLElement,
    interactions: TableInteractionHandlers,
    x: number,
    y: number,
) {
    const liveLink = target.closest(".cm-lp-link") as HTMLElement | null;
    if (liveLink?.dataset.href) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: liveLink.dataset.href,
            noteTarget: interactions.getNoteLinkTarget(liveLink.dataset.href),
        });
        return true;
    }

    const linkedImage = target.closest(
        ".cm-inline-image-link",
    ) as HTMLElement | null;
    if (linkedImage?.dataset.href) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: linkedImage.dataset.href,
            noteTarget: null,
        });
        return true;
    }

    const tableUrl = target.closest(".cm-lp-table-url") as HTMLElement | null;
    if (tableUrl?.dataset.url) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: tableUrl.dataset.url,
            noteTarget: null,
        });
        return true;
    }

    const tableWikilink = target.closest(
        ".cm-lp-table-wikilink",
    ) as HTMLElement | null;
    if (tableWikilink?.dataset.wikilinkTarget) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: tableWikilink.dataset.wikilinkTarget,
            noteTarget: tableWikilink.dataset.wikilinkTarget,
        });
        return true;
    }

    const embed = target.closest(".cm-note-embed") as HTMLElement | null;
    if (embed?.dataset.wikilinkTarget) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: embed.dataset.wikilinkTarget,
            noteTarget: embed.dataset.wikilinkTarget,
        });
        return true;
    }

    const youtubeLink = target.closest(
        ".cm-youtube-link",
    ) as HTMLElement | null;
    if (youtubeLink?.dataset.href) {
        interactions.openLinkContextMenu({
            x,
            y,
            href: youtubeLink.dataset.href,
            noteTarget: null,
        });
        return true;
    }

    return false;
}

export function livePreviewExtension(
    vaultRoot: string | null,
    interactions: TableInteractionHandlers,
) {
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            const taskLine = getTaskLinePointerTarget(
                target,
                event.clientX,
                event.clientY,
            );
            if (
                taskLine ||
                target.closest(POINTER_INTERACTIVE_PREVIEW_SELECTOR)
            ) {
                event.preventDefault();
                collapsePreviewSelection(view);
                view.focus();
                return true;
            }

            const blockWidget = target.closest(
                "[data-source-from][data-source-to]",
            ) as HTMLElement | null;
            if (!blockWidget) return false;

            const anchor = getBlockWidgetSelectionAnchor(
                blockWidget,
                event.clientY,
            );
            if (anchor === null) return false;

            event.preventDefault();
            collapsePreviewSelection(view);
            view.dispatch({ selection: { anchor } });
            view.focus();
            return true;
        },
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            const taskLine = getTaskLinePointerTarget(
                target,
                event.clientX,
                event.clientY,
            );
            if (taskLine) {
                if (!activateTaskLine(taskLine, view)) {
                    return false;
                }

                event.preventDefault();
                return true;
            }

            if (!activateInteractivePreview(target, view, interactions)) {
                return false;
            }

            event.preventDefault();
            return true;
        },
        keydown(event: KeyboardEvent, view: EditorView) {
            if (event.key !== "Enter" && event.key !== " ") {
                return false;
            }

            const target = event.target as HTMLElement;
            const taskLine = target.closest(
                ".cm-lp-task-line",
            ) as HTMLElement | null;
            if (taskLine && activateTaskLine(taskLine, view)) {
                event.preventDefault();
                return true;
            }

            if (!target.closest(KEYBOARD_INTERACTIVE_PREVIEW_SELECTOR)) {
                return false;
            }

            if (!activateInteractivePreview(target, view, interactions)) {
                return false;
            }

            event.preventDefault();
            return true;
        },
        contextmenu(event: MouseEvent) {
            const target = event.target as HTMLElement;
            if (
                !openInteractivePreviewContextMenu(
                    target,
                    interactions,
                    event.clientX,
                    event.clientY,
                )
            ) {
                return false;
            }

            event.preventDefault();
            return true;
        },
    });

    return [
        linkReferenceField,
        createInlineLivePreviewPlugin(),
        createCodeBlockLivePreviewExtension(),
        createImageLivePreviewExtension(vaultRoot),
        createImageResizeExtension(),
        createTableLivePreviewExtension(interactions),
        clickHandler,
        livePreviewTheme,
    ];
}
