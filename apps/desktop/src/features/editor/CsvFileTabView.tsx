import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
    type ReactNode,
} from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    DataSheetGrid,
    createTextColumn,
    keyColumn,
    type CellProps,
    type SimpleColumn,
} from "react-datasheet-grid";
import Papa, { type ParseError } from "papaparse";
import {
    isFileTab,
    useEditorStore,
    type FileTab,
} from "../../app/store/editorStore";
import { useEditableFileResource } from "./useEditableFileResource";

type CsvFormat = {
    delimiter: string;
    linebreak: string;
};

type CsvColumn = {
    id: string;
    name: string;
};

type CsvGridRow = Record<string, string>;

type CsvEditorState = {
    rawContent: string;
    columns: CsvColumn[];
    rows: CsvGridRow[];
    format: CsvFormat;
    isTableAvailable: boolean;
    isTableEditable: boolean;
    rawModeReason:
        | "parse_failed"
        | "too_large"
        | "truncated"
        | "preview_limited"
        | null;
    statusMessage: string | null;
    sizeBytes: number;
    totalDataRowCount: number;
};

type CsvViewMode = "table" | "raw";

type CsvIdentitySnapshot = {
    columns: CsvColumn[];
    rows: CsvGridRow[];
};

const DEFAULT_CSV_FORMAT: CsvFormat = {
    delimiter: ",",
    linebreak: "\n",
};
const CSV_ROW_ID_KEY = "__csv_row_id";
const CSV_MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MB
const CSV_MAX_PREVIEW_ROWS = 500;

const CSV_PARSE_FALLBACK_MESSAGE =
    "This CSV could not be parsed. Showing raw content instead.";
const CSV_TRUNCATED_FALLBACK_MESSAGE =
    "This tab only has a partial CSV preview. Reload the full file to edit it safely.";
const CSV_PREVIEW_LIMIT_MESSAGE =
    "Preview limited to first 500 rows. Editing disabled for large files.";

const csvTextColumn = createTextColumn<string>({
    parseUserInput: (value) => value,
    formatBlurredInput: (value) => value ?? "",
    formatInputOnFocus: (value) => value ?? "",
    deletedValue: "",
});

export function CsvFileTabView() {
    const contentRef = useRef("");
    const editorStateRef = useRef<CsvEditorState>(
        buildCsvEditorState("", null),
    );
    const gridViewportRef = useRef<HTMLDivElement>(null);
    const [editorState, setEditorState] = useState<CsvEditorState>(() => {
        const initialState = buildCsvEditorState("", null);
        contentRef.current = initialState.rawContent;
        editorStateRef.current = initialState;
        return initialState;
    });
    const [viewMode, setViewMode] = useState<CsvViewMode>("table");
    const [gridHeight, setGridHeight] = useState(420);

    const getCurrentContent = useCallback(() => contentRef.current, []);
    const applyIncomingContent = useCallback((nextContent: string) => {
        const nextState = buildCsvEditorState(
            nextContent,
            getActiveCsvTabMetadata(),
            getCsvIdentitySnapshot(editorStateRef.current),
        );
        contentRef.current = nextState.rawContent;
        editorStateRef.current = nextState;
        setEditorState(nextState);
        setViewMode((currentMode) =>
            nextState.isTableAvailable ? currentMode : "raw",
        );
    }, []);

    const {
        tab,
        hasExternalConflict,
        handleLocalContentChange,
        reloadFileFromDisk,
        keepLocalFileVersion,
    } = useEditableFileResource({
        getCurrentContent,
        applyIncomingContent,
        acceptTab: (candidate) => candidate.viewer === "csv",
    });

    const isDirty = useEditorStore((state) =>
        tab ? state.dirtyTabIds.has(tab.id) : false,
    );

    useEffect(() => {
        const node = gridViewportRef.current;
        if (!node) return;

        const syncHeight = (nextHeight: number) => {
            if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
            setGridHeight(Math.max(220, Math.floor(nextHeight)));
        };

        syncHeight(node.getBoundingClientRect().height);
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            syncHeight(entry?.contentRect.height ?? 0);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [editorState.isTableAvailable, viewMode]);

    const commitTableChange = useCallback(
        (nextColumns: CsvColumn[], nextRows: CsvGridRow[]) => {
            const normalizedRows =
                nextColumns.length === 0
                    ? []
                    : nextRows.map((row) => ({
                          ...row,
                          ...Object.fromEntries(
                              nextColumns.map((column) => [
                                  column.id,
                                  row[column.id] ?? "",
                              ]),
                          ),
                      }));
            const nextFormat = editorStateRef.current.format;
            const nextRawContent = serializeCsvTable(
                nextColumns,
                normalizedRows,
                nextFormat,
            );
            const nextState = buildCsvEditorState(
                nextRawContent,
                {
                    ...getActiveCsvTabMetadata(),
                    sizeBytes: getContentByteLength(nextRawContent),
                    contentTruncated: false,
                },
                {
                    columns: nextColumns,
                    rows: normalizedRows,
                },
            );

            contentRef.current = nextRawContent;
            editorStateRef.current = nextState;
            setEditorState(nextState);
            handleLocalContentChange(nextRawContent);
        },
        [handleLocalContentChange],
    );

    const handleGridChange = useCallback(
        (nextRows: CsvGridRow[]) => {
            const currentState = editorStateRef.current;
            if (!currentState.isTableEditable) return;
            commitTableChange(currentState.columns, nextRows);
        },
        [commitTableChange],
    );

    const handleAddRow = useCallback(() => {
        const currentState = editorStateRef.current;
        if (
            !currentState.isTableEditable ||
            currentState.columns.length === 0
        ) {
            return;
        }
        commitTableChange(currentState.columns, [
            ...currentState.rows,
            createEmptyCsvRow(currentState.columns),
        ]);
    }, [commitTableChange]);

    const handleAddColumn = useCallback(() => {
        const currentState = editorStateRef.current;
        if (!currentState.isTableEditable) return;

        const nextIndex = currentState.columns.length + 1;
        const nextColumn: CsvColumn = {
            id: createCsvEntityId("column"),
            name: `Column ${nextIndex}`,
        };
        const nextColumns = [...currentState.columns, nextColumn];
        const nextRows =
            currentState.rows.length === 0
                ? currentState.rows
                : currentState.rows.map((row) => ({
                      ...row,
                      [nextColumn.id]: "",
                  }));

        commitTableChange(nextColumns, nextRows);
    }, [commitTableChange]);

    const handleRenameColumn = useCallback(
        (columnId: string, nextName: string) => {
            const currentState = editorStateRef.current;
            if (!currentState.isTableEditable) return;
            commitTableChange(
                currentState.columns.map((column) =>
                    column.id === columnId
                        ? {
                              ...column,
                              name: nextName,
                          }
                        : column,
                ),
                currentState.rows,
            );
        },
        [commitTableChange],
    );

    const handleDeleteColumn = useCallback(
        (columnId: string) => {
            const currentState = editorStateRef.current;
            if (!currentState.isTableEditable) return;

            const nextColumns = currentState.columns.filter(
                (column) => column.id !== columnId,
            );
            const nextRows =
                nextColumns.length === 0
                    ? []
                    : currentState.rows.map((row) => {
                          const nextRow = { ...row };
                          delete nextRow[columnId];
                          return nextRow;
                      });

            commitTableChange(nextColumns, nextRows);
        },
        [commitTableChange],
    );

    const rowActionsColumn = useMemo<SimpleColumn<CsvGridRow, null>>(
        () => ({
            title: null,
            basis: 40,
            minWidth: 40,
            grow: 0,
            shrink: 0,
            component: DeleteRowCell,
            columnData: null,
        }),
        [],
    );

    const gridColumns = useMemo(
        () =>
            editorState.columns.map((column, index) => ({
                ...keyColumn(column.id, csvTextColumn),
                title: (
                    <CsvColumnHeader
                        column={column}
                        index={index}
                        onRename={handleRenameColumn}
                        onDelete={handleDeleteColumn}
                    />
                ),
                basis: 180,
                minWidth: 160,
                grow: 1,
                shrink: 0,
            })),
        [editorState.columns, handleDeleteColumn, handleRenameColumn],
    );

    const gridStructureKey = useMemo(
        () =>
            JSON.stringify({
                columns: editorState.columns.map((column) => ({
                    id: column.id,
                    name: column.name,
                })),
                rowCount: editorState.rows.length,
                editable: editorState.isTableEditable,
            }),
        [
            editorState.columns,
            editorState.rows.length,
            editorState.isTableEditable,
        ],
    );

    const createRow = useCallback(() => {
        const currentState = editorStateRef.current;
        return createEmptyCsvRow(currentState.columns);
    }, []);

    const duplicateRow = useCallback(
        ({ rowData }: { rowData: CsvGridRow }) => ({
            ...rowData,
            [CSV_ROW_ID_KEY]: createCsvEntityId("row"),
        }),
        [],
    );

    if (!tab) {
        return (
            <div
                className="h-full flex items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No CSV file tab active
            </div>
        );
    }

    const canShowTable = editorState.isTableAvailable;
    const canEditTable = editorState.isTableEditable;
    const showTable = viewMode === "table" && canShowTable;
    const tableSummary = canShowTable
        ? buildCsvTableSummary(editorState)
        : buildCsvUnavailableSummary(editorState);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {hasExternalConflict && (
                <div
                    className="shrink-0 px-3 py-2 flex items-center justify-between gap-3"
                    style={{
                        borderBottom:
                            "1px solid color-mix(in srgb, #f59e0b 35%, var(--border))",
                        background:
                            "color-mix(in srgb, #f59e0b 12%, var(--bg-secondary))",
                    }}
                >
                    <div
                        className="min-w-0 text-[12px]"
                        style={{ color: "var(--text-primary)" }}
                    >
                        This file changed on disk while you still have unsaved
                        edits.
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void reloadFileFromDisk()}
                            className="rounded-md px-2.5 py-1 text-[11px]"
                            style={{
                                border: "1px solid color-mix(in srgb, #f59e0b 45%, var(--border))",
                                backgroundColor: "var(--bg-primary)",
                                color: "var(--text-primary)",
                            }}
                        >
                            Reload from Disk
                        </button>
                        <button
                            type="button"
                            onClick={keepLocalFileVersion}
                            className="rounded-md px-2.5 py-1 text-[11px]"
                            style={{
                                border: "1px solid transparent",
                                backgroundColor: "transparent",
                                color: "var(--text-secondary)",
                            }}
                        >
                            Keep Local
                        </button>
                    </div>
                </div>
            )}

            <div
                className="flex items-center justify-between gap-2 px-3 shrink-0"
                style={{
                    height: 34,
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                }}
            >
                <div
                    className="min-w-0 truncate text-[11px]"
                    title={tab.relativePath}
                >
                    <span
                        className="font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {tab.title}
                    </span>
                    <span
                        className="ml-1.5"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {tab.relativePath}
                    </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={
                            isDirty
                                ? dirtyStatusBadgeStyle
                                : savedStatusBadgeStyle
                        }
                    >
                        {isDirty ? "Unsaved changes" : "Saved"}
                    </span>
                    <button
                        type="button"
                        onClick={() => setViewMode("table")}
                        disabled={!canShowTable}
                        className="inline-flex items-center rounded px-1.5 text-[10px] disabled:opacity-50"
                        style={
                            showTable
                                ? activeHeaderButtonStyle
                                : headerButtonStyle
                        }
                    >
                        Table
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode("raw")}
                        className="inline-flex items-center rounded px-1.5 text-[10px]"
                        style={
                            !showTable
                                ? activeHeaderButtonStyle
                                : headerButtonStyle
                        }
                    >
                        Raw
                    </button>
                    <button
                        type="button"
                        onClick={() => void openPath(tab.path)}
                        className="inline-flex items-center rounded px-1.5 text-[10px]"
                        style={headerButtonStyle}
                    >
                        Open Externally
                    </button>
                    <button
                        type="button"
                        onClick={() => void revealItemInDir(tab.path)}
                        className="inline-flex items-center rounded px-1.5 text-[10px]"
                        style={headerButtonStyle}
                    >
                        Reveal in Finder
                    </button>
                </div>
            </div>

            <div
                className="flex items-center justify-between gap-3 px-3 py-2 shrink-0"
                style={{
                    borderBottom: "1px solid var(--border)",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 45%, var(--bg-primary))",
                }}
            >
                <div
                    className="text-[11px] tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {tableSummary}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleAddRow}
                        disabled={
                            !canEditTable || editorState.columns.length === 0
                        }
                        className="rounded px-2 py-1 text-[11px] disabled:opacity-50"
                        style={secondaryActionButtonStyle}
                    >
                        Add Row
                    </button>
                    <button
                        type="button"
                        onClick={handleAddColumn}
                        disabled={!canEditTable}
                        className="rounded px-2 py-1 text-[11px] disabled:opacity-50"
                        style={secondaryActionButtonStyle}
                    >
                        Add Column
                    </button>
                </div>
            </div>

            <div
                ref={gridViewportRef}
                className="min-h-0 flex-1 overflow-hidden"
            >
                {editorState.statusMessage && (
                    <div
                        className="px-3 py-2 text-[12px] shrink-0"
                        style={{
                            borderBottom:
                                "1px solid color-mix(in srgb, #f59e0b 35%, var(--border))",
                            background:
                                "color-mix(in srgb, #f59e0b 10%, var(--bg-secondary))",
                            color: "var(--text-primary)",
                        }}
                    >
                        {editorState.statusMessage}
                    </div>
                )}
                {showTable ? (
                    editorState.columns.length > 0 ? (
                        canEditTable ? (
                            <DataSheetGrid<CsvGridRow>
                                key={gridStructureKey}
                                value={editorState.rows}
                                onChange={handleGridChange}
                                columns={gridColumns}
                                rowKey={CSV_ROW_ID_KEY}
                                createRow={createRow}
                                duplicateRow={duplicateRow}
                                addRowsComponent={false}
                                stickyRightColumn={rowActionsColumn}
                                className="csv-file-grid"
                                height={gridHeight}
                            />
                        ) : (
                            <CsvTablePreview
                                columns={editorState.columns}
                                rows={editorState.rows}
                            />
                        )
                    ) : (
                        <EmptyCsvTableState>
                            Add a column to start editing this CSV as a table.
                        </EmptyCsvTableState>
                    )
                ) : (
                    <div className="h-full flex flex-col">
                        <div className="min-h-0 flex-1 p-3">
                            <textarea
                                aria-label="Raw CSV content"
                                readOnly
                                value={editorState.rawContent}
                                className="csv-file-raw"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function CsvColumnHeader({
    column,
    index,
    onRename,
    onDelete,
}: {
    column: CsvColumn;
    index: number;
    onRename: (columnId: string, nextName: string) => void;
    onDelete: (columnId: string) => void;
}) {
    const columnLabel = getCsvColumnLabel(column, index);

    return (
        <div
            className="csv-file-column-header"
            onMouseDown={(event) => event.stopPropagation()}
        >
            <input
                aria-label={`${columnLabel} name`}
                value={column.name}
                placeholder={columnLabel}
                onChange={(event) => onRename(column.id, event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="csv-file-column-input"
            />
            <button
                type="button"
                aria-label={`Delete ${columnLabel}`}
                onMouseDown={(event) => stopHeaderButtonEvent(event)}
                onClick={(event) => {
                    stopHeaderButtonEvent(event);
                    onDelete(column.id);
                }}
                className="csv-file-column-delete"
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 0 1 1.34-1.34h2.66a1.33 1.33 0 0 1 1.34 1.34V4M6.67 7.33v4M9.33 7.33v4M12.67 4v9.33a1.33 1.33 0 0 1-1.34 1.34H4.67a1.33 1.33 0 0 1-1.34-1.34V4" />
                </svg>
            </button>
        </div>
    );
}

function DeleteRowCell({ rowIndex, deleteRow }: CellProps<CsvGridRow, null>) {
    return (
        <div className="w-full flex items-center justify-center">
            <button
                type="button"
                aria-label={`Delete row ${rowIndex + 1}`}
                onMouseDown={(event) => stopHeaderButtonEvent(event)}
                onClick={(event) => {
                    stopHeaderButtonEvent(event);
                    deleteRow();
                }}
                className="csv-file-row-delete"
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 0 1 1.34-1.34h2.66a1.33 1.33 0 0 1 1.34 1.34V4M6.67 7.33v4M9.33 7.33v4M12.67 4v9.33a1.33 1.33 0 0 1-1.34 1.34H4.67a1.33 1.33 0 0 1-1.34-1.34V4" />
                </svg>
            </button>
        </div>
    );
}

function EmptyCsvTableState({ children }: { children: ReactNode }) {
    return (
        <div
            className="h-full flex items-center justify-center px-6 text-center text-[13px]"
            style={{ color: "var(--text-secondary)" }}
        >
            {children}
        </div>
    );
}

function CsvTablePreview({
    columns,
    rows,
}: {
    columns: CsvColumn[];
    rows: CsvGridRow[];
}) {
    return (
        <div className="h-full overflow-auto">
            <table className="csv-file-preview-table">
                <thead>
                    <tr>
                        {columns.map((column, index) => (
                            <th key={column.id} scope="col">
                                {getCsvColumnLabel(column, index)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row[CSV_ROW_ID_KEY]}>
                            {columns.map((column) => (
                                <td key={column.id}>{row[column.id] ?? ""}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function buildCsvEditorState(
    content: string,
    metadata: Pick<FileTab, "sizeBytes" | "contentTruncated"> | null,
    identitySnapshot: CsvIdentitySnapshot | null = null,
): CsvEditorState {
    const format = {
        ...DEFAULT_CSV_FORMAT,
        linebreak: detectCsvLinebreak(content),
    };
    const sizeBytes = Math.max(
        metadata?.sizeBytes ?? 0,
        getContentByteLength(content),
    );

    if (metadata?.contentTruncated) {
        return {
            rawContent: content,
            columns: [],
            rows: [],
            format,
            isTableAvailable: false,
            isTableEditable: false,
            rawModeReason: "truncated",
            statusMessage: CSV_TRUNCATED_FALLBACK_MESSAGE,
            sizeBytes,
            totalDataRowCount: 0,
        };
    }

    if (sizeBytes > CSV_MAX_EDITABLE_BYTES) {
        return {
            rawContent: content,
            columns: [],
            rows: [],
            format,
            isTableAvailable: false,
            isTableEditable: false,
            rawModeReason: "too_large",
            statusMessage: `Table editing is disabled for CSV files larger than ${formatByteCount(CSV_MAX_EDITABLE_BYTES)}. Showing raw content instead.`,
            sizeBytes,
            totalDataRowCount: 0,
        };
    }

    const parsed = Papa.parse<string[]>(content, {
        skipEmptyLines: false,
    });
    const blockingErrors = parsed.errors.filter(isBlockingCsvParseError);

    if (
        blockingErrors.length > 0 ||
        parsed.meta.aborted ||
        parsed.meta.truncated
    ) {
        return {
            rawContent: content,
            columns: [],
            rows: [],
            format,
            isTableAvailable: false,
            isTableEditable: false,
            rawModeReason: "parse_failed",
            statusMessage: CSV_PARSE_FALLBACK_MESSAGE,
            sizeBytes,
            totalDataRowCount: 0,
        };
    }

    const parsedRows = normalizeParsedRows(parsed.data, content);
    const width = parsedRows.reduce(
        (maxWidth, row) => Math.max(maxWidth, row.length),
        0,
    );
    const headerValues =
        width === 0 ? [] : normalizeCsvRowWidth(parsedRows[0] ?? [], width);
    const bodyValues =
        width === 0
            ? []
            : parsedRows
                  .slice(1)
                  .map((row) => normalizeCsvRowWidth(row, width));
    const columns = headerValues.map((name, index) => ({
        id: identitySnapshot?.columns[index]?.id ?? createCsvEntityId("column"),
        name,
    }));
    const allRows = bodyValues.map((values, index) =>
        createCsvRow(
            columns,
            values,
            identitySnapshot?.rows[index]?.[CSV_ROW_ID_KEY],
        ),
    );
    const exceedsPreviewLimit = allRows.length > CSV_MAX_PREVIEW_ROWS;
    const rows = exceedsPreviewLimit
        ? allRows.slice(0, CSV_MAX_PREVIEW_ROWS)
        : allRows;

    return {
        rawContent: content,
        columns,
        rows,
        format: {
            delimiter: parsed.meta.delimiter || DEFAULT_CSV_FORMAT.delimiter,
            linebreak: parsed.meta.linebreak || format.linebreak,
        },
        isTableAvailable: true,
        isTableEditable: !exceedsPreviewLimit,
        rawModeReason: exceedsPreviewLimit ? "preview_limited" : null,
        statusMessage: exceedsPreviewLimit ? CSV_PREVIEW_LIMIT_MESSAGE : null,
        sizeBytes,
        totalDataRowCount: allRows.length,
    };
}

function serializeCsvTable(
    columns: CsvColumn[],
    rows: CsvGridRow[],
    format: CsvFormat,
) {
    if (columns.length === 0) {
        return "";
    }

    return Papa.unparse(
        {
            fields: columns.map((column) => column.name),
            data: rows.map((row) =>
                columns.map((column) => row[column.id] ?? ""),
            ),
        },
        {
            delimiter: format.delimiter,
            newline: format.linebreak,
        },
    );
}

function normalizeParsedRows(data: string[][], originalContent: string) {
    const rows = data.map((row) => row.map((value) => value ?? ""));
    if (
        rows.length > 0 &&
        hasTrailingCsvLinebreak(originalContent) &&
        rows.at(-1)?.every((cell) => cell === "")
    ) {
        rows.pop();
    }
    return rows;
}

function normalizeCsvRowWidth(row: string[], width: number) {
    const nextRow = row.slice(0, width);
    while (nextRow.length < width) {
        nextRow.push("");
    }
    return nextRow;
}

function createCsvRow(
    columns: CsvColumn[],
    values: string[],
    rowId: string | undefined = undefined,
): CsvGridRow {
    return {
        [CSV_ROW_ID_KEY]: rowId ?? createCsvEntityId("row"),
        ...Object.fromEntries(
            columns.map((column, index) => [column.id, values[index] ?? ""]),
        ),
    };
}

function createEmptyCsvRow(columns: CsvColumn[]): CsvGridRow {
    return createCsvRow(
        columns,
        columns.map(() => ""),
    );
}

function createCsvEntityId(prefix: "column" | "row") {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveCsvTabMetadata() {
    const state = useEditorStore.getState();
    const activeTab = state.tabs.find(
        (candidate) => candidate.id === state.activeTabId,
    );
    if (!activeTab || !isFileTab(activeTab) || activeTab.viewer !== "csv") {
        return null;
    }
    return {
        sizeBytes: activeTab.sizeBytes,
        contentTruncated: activeTab.contentTruncated,
    };
}

function getCsvIdentitySnapshot(
    state: CsvEditorState | null,
): CsvIdentitySnapshot | null {
    if (!state || !state.isTableAvailable) {
        return null;
    }

    return {
        columns: state.columns,
        rows: state.rows,
    };
}

function getContentByteLength(content: string) {
    return new TextEncoder().encode(content).length;
}

function detectCsvLinebreak(content: string) {
    return content.includes("\r\n") ? "\r\n" : DEFAULT_CSV_FORMAT.linebreak;
}

function hasTrailingCsvLinebreak(content: string) {
    return content.endsWith("\n") || content.endsWith("\r\n");
}

function isBlockingCsvParseError(error: ParseError) {
    // Papa reports undetectable delimiter warnings for tiny or trailing-newline
    // inputs even when the parsed table is otherwise perfectly usable.
    return !(
        error.type === "Delimiter" && error.code === "UndetectableDelimiter"
    );
}

function getCsvColumnLabel(column: CsvColumn, index: number) {
    return column.name.trim() || `Column ${index + 1}`;
}

function buildCsvUnavailableSummary(state: CsvEditorState) {
    if (state.rawModeReason === "too_large") {
        return `Table editing unavailable · ${formatByteCount(state.sizeBytes)}`;
    }
    if (state.rawModeReason === "truncated") {
        return "Partial preview · table editing unavailable";
    }
    return "Raw fallback · table editing unavailable";
}

function buildCsvTableSummary(state: CsvEditorState) {
    if (state.rawModeReason === "preview_limited") {
        return `Rows: ${state.rows.length} of ${state.totalDataRowCount} · Columns: ${state.columns.length}`;
    }
    return `Rows: ${state.rows.length} · Columns: ${state.columns.length}`;
}

function formatByteCount(sizeBytes: number) {
    if (sizeBytes >= 1024 * 1024) {
        return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (sizeBytes >= 1024) {
        return `${Math.round(sizeBytes / 1024)} KB`;
    }
    return `${sizeBytes} B`;
}

function stopHeaderButtonEvent(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
}

const headerButtonStyle = {
    height: 22,
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
} as const;

const activeHeaderButtonStyle = {
    ...headerButtonStyle,
    border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
    backgroundColor: "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
} as const;

const secondaryActionButtonStyle = {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
} as const;

const savedStatusBadgeStyle = {
    border: "1px solid color-mix(in srgb, #16a34a 32%, var(--border))",
    backgroundColor: "color-mix(in srgb, #16a34a 10%, var(--bg-primary))",
    color: "var(--text-primary)",
} as const;

const dirtyStatusBadgeStyle = {
    border: "1px solid color-mix(in srgb, #f59e0b 38%, var(--border))",
    backgroundColor: "color-mix(in srgb, #f59e0b 12%, var(--bg-primary))",
    color: "var(--text-primary)",
} as const;
