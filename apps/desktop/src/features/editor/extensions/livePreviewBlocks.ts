import {
    Decoration,
    type DecorationSet,
    EditorView,
    WidgetType,
} from "@codemirror/view";
import {
    type EditorState,
    RangeSetBuilder,
    StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
    extractYouTubeVideoId,
    getYouTubePreview,
    getYouTubeThumbnailUrl,
} from "../youtube";

import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    type DecoEntry,
    buildLinkReferenceIndex,
    findAncestor,
    normalizeReferenceLabel,
    parseLinkChildren,
    resolveLinkHref,
} from "./livePreviewHelpers";
import { selectionTouchesRange } from "./selectionActivity";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)([?#].*)?$/i;
const TABLE_WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const TABLE_URL_RE = /https?:\/\/[^\s<>()"\]]+/g;
const TABLE_BOLD_RE = /\*\*(?=\S)(.+?\S)\*\*/g;
const TABLE_HIGHLIGHT_RE = /==(?=\S)(.+?\S)==/g;
const STANDALONE_URL_RE = /^https?:\/\/[^\s<>()"\]]+$/i;
type TableAlignment = "left" | "center" | "right";
export interface TableInteractionHandlers {
    resolveWikilink: (target: string) => boolean;
    navigateWikilink: (target: string) => void;
    getNoteLinkTarget: (href: string) => string | null;
    openLinkContextMenu: (payload: {
        x: number;
        y: number;
        href: string;
        noteTarget: string | null;
    }) => void;
}
type ParsedTableCell = {
    content: string;
    from: number;
    to: number;
};
type ParsedTableRow = {
    cells: ParsedTableCell[];
    lineEnd: number;
};

class ImageWidget extends WidgetType {
    private src: string;
    private alt: string;
    private href: string | null;
    private title: string | null;

    constructor(
        src: string,
        alt: string,
        href: string | null = null,
        title: string | null = null,
    ) {
        super();
        this.src = src;
        this.alt = alt;
        this.href = href;
        this.title = title;
    }

    eq(other: ImageWidget) {
        return (
            this.src === other.src &&
            this.alt === other.alt &&
            this.href === other.href &&
            this.title === other.title
        );
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-inline-image-wrapper";
        wrapper.setAttribute("contenteditable", "false");
        if (this.href) {
            wrapper.classList.add("cm-inline-image-link");
            wrapper.dataset.href = this.href;
        }

        const img = document.createElement("img");
        img.src = this.src;
        img.alt = this.alt;
        img.className = "cm-inline-image";
        img.draggable = false;
        if (this.title) img.title = this.title;

        img.onerror = () => {
            img.style.display = "none";
            const fallback = document.createElement("span");
            fallback.className = "cm-inline-image-fallback";
            fallback.textContent = `Image not found: ${this.alt || this.src}`;
            wrapper.appendChild(fallback);
        };

        wrapper.appendChild(img);
        return wrapper;
    }

    ignoreEvent() {
        return false;
    }
}

class YouTubeWidget extends WidgetType {
    private href: string;
    private title: string;

    constructor(href: string, title: string) {
        super();
        this.href = href;
        this.title = title;
    }

    eq(other: YouTubeWidget) {
        return (
            this.href === other.href &&
            this.title === other.title
        );
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-youtube-link";
        wrapper.dataset.href = this.href;
        wrapper.dataset.title = this.title;
        wrapper.setAttribute("contenteditable", "false");

        const media = document.createElement("div");
        media.className = "cm-youtube-link-media";

        const thumbnail = document.createElement("img");
        thumbnail.className = "cm-youtube-link-thumbnail";
        thumbnail.alt = this.title;
        thumbnail.loading = "lazy";
        thumbnail.decoding = "async";

        const thumbnailUrl = getYouTubeThumbnailUrl(this.href);
        if (thumbnailUrl) {
            thumbnail.src = thumbnailUrl;
        } else {
            media.dataset.noThumbnail = "true";
        }
        thumbnail.onerror = () => {
            media.dataset.noThumbnail = "true";
        };

        const play = document.createElement("div");
        play.className = "cm-youtube-link-play";
        play.setAttribute("aria-hidden", "true");

        media.appendChild(thumbnail);
        media.appendChild(play);

        const body = document.createElement("div");
        body.className = "cm-youtube-link-body";

        const label = document.createElement("div");
        label.className = "cm-youtube-link-label";
        label.textContent = this.title;

        const meta = document.createElement("div");
        meta.className = "cm-youtube-link-meta";
        meta.textContent = "Play in app";

        body.appendChild(label);
        body.appendChild(meta);

        wrapper.appendChild(media);
        wrapper.appendChild(body);

        void getYouTubePreview(this.href).then((preview) => {
            if (!wrapper.isConnected) return;

            if (preview.thumbnailUrl && thumbnail.src !== preview.thumbnailUrl) {
                thumbnail.src = preview.thumbnailUrl;
            }

            if (preview.title) {
                label.textContent = preview.title;
                thumbnail.alt = preview.title;
                wrapper.dataset.title = preview.title;
            }
        });

        return wrapper;
    }

    ignoreEvent() {
        return false;
    }
}

class NoteEmbedWidget extends WidgetType {
    private target: string;

    constructor(target: string) {
        super();
        this.target = target;
    }

    eq(other: NoteEmbedWidget) {
        return this.target === other.target;
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-note-embed";
        wrapper.dataset.wikilinkTarget = this.target;
        wrapper.setAttribute("contenteditable", "false");

        const note = useVaultStore
            .getState()
            .notes.find(
                (entry) =>
                    entry.id === this.target ||
                    entry.title === this.target ||
                    entry.id.replace(/\.md$/i, "") === this.target,
            );
        const openTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) =>
                    tab.noteId === note?.id ||
                    tab.noteId === this.target ||
                    tab.title === this.target,
            );

        const title = document.createElement("div");
        title.className = "cm-note-embed-title";
        title.textContent = note?.title ?? this.target;

        const meta = document.createElement("div");
        meta.className = "cm-note-embed-meta";
        meta.textContent = openTab?.content
            ? openTab.content.split(/\r?\n/).find((line) => line.trim()) ??
              (note?.path ?? this.target)
            : (note?.path ?? this.target);

        wrapper.appendChild(title);
        wrapper.appendChild(meta);
        return wrapper;
    }

    ignoreEvent() {
        return false;
    }
}

function countLeadingWhitespace(value: string): number {
    let count = 0;
    while (count < value.length && /\s/.test(value[count])) {
        count++;
    }
    return count;
}

function countTrailingWhitespace(value: string): number {
    let count = 0;
    while (count < value.length && /\s/.test(value[value.length - 1 - count])) {
        count++;
    }
    return count;
}

function parseTableRow(
    line: string,
    lineStart: number,
): ParsedTableRow {
    const separators: number[] = [];
    for (let index = 0; index < line.length; index++) {
        if (line[index] === "|" && line[index - 1] !== "\\") {
            separators.push(index);
        }
    }

    const rawSegments: Array<{ start: number; end: number; raw: string }> = [];
    let segmentStart = 0;
    for (const separator of separators) {
        rawSegments.push({
            start: segmentStart,
            end: separator,
            raw: line.slice(segmentStart, separator),
        });
        segmentStart = separator + 1;
    }
    rawSegments.push({
        start: segmentStart,
        end: line.length,
        raw: line.slice(segmentStart),
    });

    if (rawSegments.length > 1 && rawSegments[0]?.raw.trim() === "") {
        rawSegments.shift();
    }
    if (
        rawSegments.length > 1 &&
        rawSegments[rawSegments.length - 1]?.raw.trim() === ""
    ) {
        rawSegments.pop();
    }

    const cells = rawSegments.map(({ start, end, raw }) => {
        const leadingWhitespace = countLeadingWhitespace(raw);
        const trailingWhitespace = countTrailingWhitespace(raw);
        const trimmedStart = Math.min(start + leadingWhitespace, end);
        const trimmedEnd = Math.max(trimmedStart, end - trailingWhitespace);

        return {
            content: raw.trim(),
            from: lineStart + trimmedStart,
            to: lineStart + trimmedEnd,
        };
    });

    return {
        cells,
        lineEnd: lineStart + line.length,
    };
}

function splitSourceLines(source: string) {
    const lines = source.split(/\r?\n/);
    const result: Array<{ text: string; start: number }> = [];
    let offset = 0;

    for (const line of lines) {
        result.push({ text: line, start: offset });
        offset += line.length;

        if (source.startsWith("\r\n", offset)) {
            offset += 2;
        } else if (source.startsWith("\n", offset)) {
            offset += 1;
        }
    }

    return result;
}

function parseTableAlignment(cell: string): TableAlignment | null {
    const normalized = cell.trim();
    if (!/^:?-{3,}:?$/.test(normalized)) return null;
    const left = normalized.startsWith(":");
    const right = normalized.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
}

function padRow(row: string[], width: number): string[] {
    if (row.length >= width) return row;
    return [...row, ...Array.from({ length: width - row.length }, () => "")];
}

function padCellRow(row: ParsedTableRow, width: number): ParsedTableCell[] {
    if (row.cells.length >= width) return row.cells;
    return [
        ...row.cells,
        ...Array.from({ length: width - row.cells.length }, () => ({
            content: "",
            from: row.lineEnd,
            to: row.lineEnd,
        })),
    ];
}

function parseMarkdownTable(source: string) {
    const lines = splitSourceLines(source).filter((line) => line.text.trim().length > 0);

    if (lines.length < 2) return null;

    const header = parseTableRow(lines[0].text, lines[0].start);
    const delimiter = parseTableRow(lines[1].text, lines[1].start);
    if (!header.cells.length || header.cells.length !== delimiter.cells.length) {
        return null;
    }

    const alignments = delimiter.cells.map((cell) =>
        parseTableAlignment(cell.content),
    );
    if (alignments.some((alignment) => alignment === null)) {
        return null;
    }

    const body = lines.slice(2).map((line) => parseTableRow(line.text, line.start));
    const columnCount = Math.max(
        header.cells.length,
        ...body.map((row) => row.cells.length),
    );

    return {
        header: padCellRow(header, columnCount),
        columnCount,
        alignments: padRow(
            alignments.map((alignment) => alignment ?? ""),
            columnCount,
        ).map((alignment) => (alignment || "left") as TableAlignment),
        rows: body.map((row) => padCellRow(row, columnCount)),
    };
}

function createTableCell(
    tagName: "div",
    cellInfo: ParsedTableCell,
    alignment: TableAlignment,
    interactions: TableInteractionHandlers,
) {
    const cell = document.createElement(tagName);
    cell.className = "cm-lp-table-cell";
    cell.dataset.sourceFrom = String(cellInfo.from);
    cell.dataset.align = alignment;
    appendInteractiveTableContent(cell, cellInfo.content, interactions);
    return cell;
}

function trimUrlMatch(url: string) {
    return url.replace(/[.,;:!?)}\]'"]+$/g, "");
}

function appendInteractiveTableContent(
    parent: HTMLElement,
    content: string,
    interactions: TableInteractionHandlers,
) {
    let index = 0;

    while (index < content.length) {
        TABLE_WIKILINK_RE.lastIndex = index;
        TABLE_URL_RE.lastIndex = index;

        const wikilinkMatch = TABLE_WIKILINK_RE.exec(content);
        const urlMatch = TABLE_URL_RE.exec(content);
        const nextMatch = [wikilinkMatch, urlMatch]
            .filter((match): match is RegExpExecArray => match !== null)
            .sort((left, right) => left.index - right.index)[0];

        if (!nextMatch) {
            appendInlineTableFormatting(parent, content.slice(index));
            break;
        }

        if (nextMatch.index > index) {
            appendInlineTableFormatting(
                parent,
                content.slice(index, nextMatch.index),
            );
        }

        if (nextMatch === wikilinkMatch) {
            const inner = nextMatch[1];
            const pipeIndex = inner.indexOf("|");
            const target =
                pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
            const label =
                pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : target;
            const link = document.createElement("span");
            link.className = interactions.resolveWikilink(target)
                ? "cm-lp-table-link cm-lp-table-wikilink cm-lp-table-wikilink-valid"
                : "cm-lp-table-link cm-lp-table-wikilink cm-lp-table-wikilink-broken";
            link.dataset.wikilinkTarget = target;
            link.textContent = label || target;
            parent.appendChild(link);
        } else {
            const url = trimUrlMatch(nextMatch[0]);
            const link = document.createElement("span");
            link.className = "cm-lp-table-link cm-lp-table-url";
            link.dataset.url = url;
            link.textContent = url;
            parent.appendChild(link);
        }

        index =
            nextMatch.index +
            (nextMatch === wikilinkMatch
                ? nextMatch[0].length
                : trimUrlMatch(nextMatch[0]).length);
    }
}

function appendInlineTableFormatting(parent: HTMLElement, content: string) {
    let index = 0;

    while (index < content.length) {
        TABLE_BOLD_RE.lastIndex = index;
        TABLE_HIGHLIGHT_RE.lastIndex = index;

        const boldMatch = TABLE_BOLD_RE.exec(content);
        const highlightMatch = TABLE_HIGHLIGHT_RE.exec(content);
        const nextMatch = [boldMatch, highlightMatch]
            .filter((match): match is RegExpExecArray => match !== null)
            .sort((left, right) => left.index - right.index)[0];

        if (!nextMatch) {
            parent.appendChild(document.createTextNode(content.slice(index)));
            break;
        }

        if (nextMatch.index > index) {
            parent.appendChild(
                document.createTextNode(content.slice(index, nextMatch.index)),
            );
        }

        const span = document.createElement("span");
        if (nextMatch === boldMatch) {
            span.className = "cm-lp-table-bold";
        } else {
            span.className = "cm-lp-table-highlight";
        }
        span.textContent = nextMatch[1];
        parent.appendChild(span);

        index = nextMatch.index + nextMatch[0].length;
    }
}

class TableWidget extends WidgetType {
    private source: string;
    private from: number;
    private interactions: TableInteractionHandlers;

    constructor(
        source: string,
        from: number,
        interactions: TableInteractionHandlers,
    ) {
        super();
        this.source = source;
        this.from = from;
        this.interactions = interactions;
    }

    eq(other: TableWidget) {
        return this.source === other.source && this.from === other.from;
    }

    toDOM() {
        const parsed = parseMarkdownTable(this.source);
        const wrapper = document.createElement("div");
        wrapper.className = "cm-lp-table-widget";
        wrapper.dataset.sourceFrom = String(this.from);
        wrapper.setAttribute("contenteditable", "false");

        if (!parsed) {
            const fallback = document.createElement("pre");
            fallback.className = "cm-lp-table-fallback";
            fallback.textContent = this.source;
            wrapper.appendChild(fallback);
            return wrapper;
        }

        const table = document.createElement("div");
        table.className = "cm-lp-table";
        table.style.setProperty("--cm-lp-table-columns", String(parsed.columnCount));

        const headerRow = document.createElement("div");
        headerRow.className = "cm-lp-table-row cm-lp-table-row-header";
        parsed.header.forEach((cellInfo, index) => {
            headerRow.appendChild(
                createTableCell(
                    "div",
                    cellInfo,
                    parsed.alignments[index],
                    this.interactions,
                ),
            );
        });
        table.appendChild(headerRow);

        parsed.rows.forEach((row) => {
            const tr = document.createElement("div");
            tr.className = "cm-lp-table-row";
            row.forEach((cellInfo, index) => {
                tr.appendChild(
                    createTableCell(
                        "div",
                        cellInfo,
                        parsed.alignments[index],
                        this.interactions,
                    ),
                );
            });
            table.appendChild(tr);
        });

        wrapper.appendChild(table);
        return wrapper;
    }

    ignoreEvent() {
        return false;
    }
}

function resolveImageUrl(rawUrl: string, vaultRoot: string | null): string {
    if (
        rawUrl.startsWith("http://") ||
        rawUrl.startsWith("https://") ||
        rawUrl.startsWith("data:")
    ) {
        return rawUrl;
    }
    if (!vaultRoot) return rawUrl;
    const path = rawUrl.startsWith("/") ? rawUrl : `${vaultRoot}/${rawUrl}`;
    return convertFileSrc(path);
}

function isRenderableImageUrl(url: string): boolean {
    return (
        url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("data:image/") ||
        IMAGE_EXTENSIONS.test(url)
    );
}

function parseWikilinkEmbedTarget(raw: string): string | null {
    const match = raw.match(/^!\[\[([^\]]+)\]\]$/);
    if (!match) return null;
    return match[1].split("|", 1)[0]?.trim() ?? null;
}

function isStandaloneLinkNode(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    const startLine = state.doc.lineAt(from);
    const endLine = state.doc.lineAt(Math.max(from, to - 1));
    if (startLine.number !== endLine.number) return false;

    const before = state.doc.sliceString(startLine.from, from);
    const after = state.doc.sliceString(to, startLine.to);
    return before.trim().length === 0 && after.trim().length === 0;
}

function findStandaloneUrlLineRange(
    state: EditorState,
    lineNumber: number,
): { from: number; to: number; href: string } | null {
    const line = state.doc.line(lineNumber);
    const trimmed = line.text.trim();
    if (!trimmed || !STANDALONE_URL_RE.test(trimmed)) {
        return null;
    }

    const href = trimmed.replace(/[.,;:!?)}\]'"]+$/g, "");
    if (!href || href !== trimmed || !extractYouTubeVideoId(href)) {
        return null;
    }

    const leadingWhitespace = line.text.length - line.text.trimStart().length;
    return {
        from: line.from + leadingWhitespace,
        to: line.from + leadingWhitespace + href.length,
        href,
    };
}

function hasOverlappingDecoration(
    decos: DecoEntry[],
    from: number,
    to: number,
): boolean {
    return decos.some(
        (entry) => entry.from < to && entry.to > from,
    );
}

function buildBlockDecorations(
    state: EditorState,
    vaultRoot: string | null,
): DecorationSet {
    const decos: DecoEntry[] = [];
    const linkReferences = buildLinkReferenceIndex(state);

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name === "Link" || node.name === "Autolink") {
                if (selectionTouchesRange(state, node.from, node.to)) return;
                if (!isStandaloneLinkNode(state, node.from, node.to)) return;

                const info = parseLinkChildren(node.node, state);
                if (!info) return;

                const href = resolveLinkHref(info, linkReferences);
                if (!href || !extractYouTubeVideoId(href)) return;

                const label =
                    state.doc.sliceString(info.textFrom, info.textTo).trim() ||
                    info.title ||
                    "YouTube video";

                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new YouTubeWidget(href, label),
                        block: true,
                    }),
                });
                return;
            }

            if (node.name !== "Image") return;

            const raw = state.doc.sliceString(node.from, node.to);
            const embedTarget = parseWikilinkEmbedTarget(raw);
            if (embedTarget) {
                if (selectionTouchesRange(state, node.from, node.to)) return;
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: IMAGE_EXTENSIONS.test(embedTarget)
                            ? new ImageWidget(
                                  resolveImageUrl(embedTarget, vaultRoot),
                                  embedTarget,
                              )
                            : new NoteEmbedWidget(embedTarget),
                        block: true,
                    }),
                });
                return;
            }

            const info = parseLinkChildren(node.node, state);
            if (!info) {
                return;
            }
            const resolvedImageHref = resolveLinkHref(info, linkReferences);
            if (!resolvedImageHref) {
                return;
            }
            if (selectionTouchesRange(state, node.from, node.to)) return;

            const altText = state.doc.sliceString(info.textFrom, info.textTo);
            const youtubeVideoId = extractYouTubeVideoId(resolvedImageHref);
            const parentLink = findAncestor(node.node.parent, "Link");
            const outerLinkInfo = parentLink
                ? parseLinkChildren(parentLink, state)
                : null;
            const href = outerLinkInfo
                ? resolveLinkHref(outerLinkInfo, linkReferences)
                : null;

            if (youtubeVideoId) {
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new YouTubeWidget(
                            resolvedImageHref,
                            altText || "YouTube video",
                        ),
                        block: true,
                    }),
                });
                return;
            }

            if (!isRenderableImageUrl(resolvedImageHref)) {
                return;
            }

            const resolvedUrl = resolveImageUrl(resolvedImageHref, vaultRoot);

            decos.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({
                    widget: new ImageWidget(
                        resolvedUrl,
                        altText,
                        href,
                        info.title ??
                            (info.label
                                ? linkReferences.get(
                                      normalizeReferenceLabel(info.label),
                                  )?.title ?? null
                                : null),
                    ),
                    block: false,
                }),
            });
        },
    });

    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
        const standaloneUrl = findStandaloneUrlLineRange(state, lineNumber);
        if (!standaloneUrl) continue;
        if (
            selectionTouchesRange(
                state,
                standaloneUrl.from,
                standaloneUrl.to,
            )
        ) {
            continue;
        }
        if (
            hasOverlappingDecoration(
                decos,
                standaloneUrl.from,
                standaloneUrl.to,
            )
        ) {
            continue;
        }

        decos.push({
            from: standaloneUrl.from,
            to: standaloneUrl.to,
            deco: Decoration.replace({
                widget: new YouTubeWidget(
                    standaloneUrl.href,
                    "YouTube video",
                ),
                block: true,
            }),
        });
    }

    decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

function buildTableDecorations(
    state: EditorState,
    interactions: TableInteractionHandlers,
): DecorationSet {
    const decos: DecoEntry[] = [];

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== "Table") return;
            if (selectionTouchesRange(state, node.from, node.to)) {
                return false;
            }

            const source = state.doc.sliceString(node.from, node.to);
            decos.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({
                    widget: new TableWidget(source, node.from, interactions),
                    block: true,
                }),
            });
            return false;
        },
    });

    decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

export function createImageLivePreviewExtension(vaultRoot: string | null) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildBlockDecorations(state, vaultRoot);
        },
        update(_decorations, transaction) {
            return buildBlockDecorations(transaction.state, vaultRoot);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}

export function createTableLivePreviewExtension(
    interactions: TableInteractionHandlers,
) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildTableDecorations(state, interactions);
        },
        update(_decorations, transaction) {
            return buildTableDecorations(transaction.state, interactions);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}
