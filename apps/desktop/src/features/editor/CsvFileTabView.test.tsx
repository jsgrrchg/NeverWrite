import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CsvFileTabView } from "./CsvFileTabView";
import {
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
} from "../../test/test-utils";

function configureCsvSaveEcho() {
    mockInvoke().mockImplementation(async (command, rawPayload) => {
        if (command !== "save_vault_file") {
            throw new Error(`Unexpected command: ${command}`);
        }

        const payload = rawPayload as Record<string, string>;
        return {
            relative_path: payload.relativePath,
            file_name: payload.relativePath.split("/").pop(),
            content: payload.content,
        };
    });
}

function getLastSavePayload() {
    const saveCalls = mockInvoke().mock.calls.filter(
        ([command]) => command === "save_vault_file",
    );
    const lastCall = saveCalls.at(-1);
    expect(lastCall).toBeDefined();
    return lastCall?.[1] as Record<string, string>;
}

function getGridInputs(container: HTMLElement) {
    return Array.from(
        container.querySelectorAll(".dsg-row:not(.dsg-row-header) input"),
    ) as HTMLInputElement[];
}

describe("CsvFileTabView", () => {
    beforeEach(() => {
        setVaultEntries([], "/vault");
    });

    it("edits a cell and autosaves the updated csv content", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/report.csv",
                title: "report.csv",
                path: "/vault/data/report.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
            },
        ]);

        renderComponent(<CsvFileTabView />);

        fireEvent.change(screen.getByDisplayValue("Alice"), {
            target: { value: "Bob" },
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(screen.getByDisplayValue("Bob")).toBeInTheDocument();
        expect(screen.getByDisplayValue("10")).toBeInTheDocument();
        expect(getLastSavePayload()).toMatchObject({
            vaultPath: "/vault",
            relativePath: "data/report.csv",
            content: "name,amount\nBob,10",
            opId: expect.any(String),
        });
    });

    it("adds and deletes rows while keeping the serialized csv in sync", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/report.csv",
                title: "report.csv",
                path: "/vault/data/report.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
            },
        ]);

        const { container } = renderComponent(<CsvFileTabView />);

        fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
        const inputsAfterAdd = getGridInputs(container);
        expect(inputsAfterAdd).toHaveLength(4);

        fireEvent.change(inputsAfterAdd[2], {
            target: { value: "Bob" },
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
        expect(screen.getByDisplayValue("Bob")).toBeInTheDocument();
        expect(getLastSavePayload()).toMatchObject({
            content: "name,amount\nAlice,10\nBob,",
        });

        fireEvent.click(screen.getByRole("button", { name: "Delete row 1" }));

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(screen.queryByDisplayValue("Alice")).not.toBeInTheDocument();
        expect(screen.getByDisplayValue("Bob")).toBeInTheDocument();
        expect(getLastSavePayload()).toMatchObject({
            content: "name,amount\nBob,",
        });
    });

    it("adds and deletes columns while keeping the serialized csv in sync", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/report.csv",
                title: "report.csv",
                path: "/vault/data/report.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
            },
        ]);

        const { container } = renderComponent(<CsvFileTabView />);

        fireEvent.click(screen.getByRole("button", { name: "Add Column" }));
        const columnNameInput = screen.getByLabelText("Column 3 name");
        expect(columnNameInput).toBeInTheDocument();

        const inputsAfterAdd = getGridInputs(container);
        expect(inputsAfterAdd).toHaveLength(3);

        fireEvent.change(inputsAfterAdd[2], {
            target: { value: "notes" },
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(screen.getByLabelText("Column 3 name")).toBeInTheDocument();
        expect(screen.getByDisplayValue("notes")).toBeInTheDocument();
        expect(getLastSavePayload()).toMatchObject({
            content: "name,amount,Column 3\nAlice,10,notes",
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Delete Column 3" }),
        );

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(
            screen.queryByRole("button", { name: "Delete Column 3" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue("notes")).not.toBeInTheDocument();
        expect(getLastSavePayload()).toMatchObject({
            content: "name,amount\nAlice,10",
        });
    });

    it("falls back to raw mode when the csv cannot be parsed safely", () => {
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/broken.csv",
                title: "broken.csv",
                path: "/vault/data/broken.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: 'name,amount\n"Alice,10',
            },
        ]);

        renderComponent(<CsvFileTabView />);

        expect(screen.getByRole("button", { name: "Table" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
        expect(
            screen.getByText(
                "This CSV could not be parsed. Showing raw content instead.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByLabelText("Raw CSV content")).toHaveValue(
            'name,amount\n"Alice,10',
        );
    });

    it("disables table editing for large csv files", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/large.csv",
                title: "large.csv",
                path: "/vault/data/large.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
                sizeBytes: 2 * 1024 * 1024 + 1,
            },
        ]);

        renderComponent(<CsvFileTabView />);

        expect(screen.getByRole("button", { name: "Table" })).toBeDisabled();
        expect(
            screen.getByText(
                /Table editing is disabled for CSV files larger than/i,
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Table editing unavailable · 2.0 MB"),
        ).toBeInTheDocument();

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(
            mockInvoke().mock.calls.filter(
                ([command]) => command === "save_vault_file",
            ),
        ).toHaveLength(0);
    });

    it("keeps table editing enabled at the 2 MB limit", () => {
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/exact-limit.csv",
                title: "exact-limit.csv",
                path: "/vault/data/exact-limit.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
                sizeBytes: 2 * 1024 * 1024,
            },
        ]);

        renderComponent(<CsvFileTabView />);

        expect(screen.getByRole("button", { name: "Table" })).toBeEnabled();
        expect(
            screen.queryByText(
                /Table editing is disabled for CSV files larger than/i,
            ),
        ).not.toBeInTheDocument();
        expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
    });

    it("shows a read-only table preview when the csv exceeds 500 data rows", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        const content = [
            "name,amount",
            ...Array.from(
                { length: 501 },
                (_, index) => `row${index},${index}`,
            ),
        ].join("\n");

        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/preview.csv",
                title: "preview.csv",
                path: "/vault/data/preview.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content,
            },
        ]);

        renderComponent(<CsvFileTabView />);

        expect(screen.getByRole("button", { name: "Table" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Add Row" })).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Add Column" }),
        ).toBeDisabled();
        expect(
            screen.getByText(
                "Preview limited to first 500 rows. Editing disabled for large files.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Rows: 500 of 501 · Columns: 2"),
        ).toBeInTheDocument();
        expect(screen.getByText("row499")).toBeInTheDocument();
        expect(screen.queryByText("row500")).not.toBeInTheDocument();

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(
            mockInvoke().mock.calls.filter(
                ([command]) => command === "save_vault_file",
            ),
        ).toHaveLength(0);
    });

    it("disables editing when the tab only contains a partial csv preview", async () => {
        vi.useFakeTimers();
        configureCsvSaveEcho();
        setEditorTabs([
            {
                id: "csv-tab",
                kind: "file",
                relativePath: "data/partial.csv",
                title: "partial.csv",
                path: "/vault/data/partial.csv",
                mimeType: "text/csv",
                viewer: "csv",
                content: "name,amount\nAlice,10",
                contentTruncated: true,
            },
        ]);

        renderComponent(<CsvFileTabView />);

        expect(screen.getByRole("button", { name: "Table" })).toBeDisabled();
        expect(
            screen.getByText(
                "This tab only has a partial CSV preview. Reload the full file to edit it safely.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Partial preview · table editing unavailable"),
        ).toBeInTheDocument();

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(
            mockInvoke().mock.calls.filter(
                ([command]) => command === "save_vault_file",
            ),
        ).toHaveLength(0);
    });
});
