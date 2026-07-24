import { confirm, invoke, revealItemInDir } from "@neverwrite/runtime";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { useChatStore } from "../store/chatStore";
import { AIHistoryStorageControl } from "./AIHistoryStorageControl";

describe("AIHistoryStorageControl", () => {
    beforeEach(() => {
        vi.mocked(confirm).mockResolvedValue(true);
        useChatStore.setState({
            historyStorageVaultPath: "/vault",
            historyStorageStatus: {
                vaultKey: "vault-key",
                generation: 1,
                status: "ready",
                scope: "device",
                orphanedDeviceHistories: [],
            },
            refreshAiHistoryStorageStatus: vi.fn(async () => undefined),
            changeAiHistoryStorage: vi.fn(async () => true),
        });
    });

    it("confirms the full move before requesting a scope change", async () => {
        renderComponent(<AIHistoryStorageControl vaultPath="/vault" />);

        fireEvent.click(
            screen.getByRole("switch", {
                name: "Store AI chats inside this vault",
            }),
        );

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledWith(
                "This moves all saved AI chats and NeverWrite-managed pasted attachments. The storage setting changes only after the move succeeds.",
                {
                    title: "Move all AI chats into this vault?",
                    kind: "warning",
                    okLabel: "Move all chats",
                    cancelLabel: "Cancel",
                },
            );
        });
        expect(
            useChatStore.getState().changeAiHistoryStorage,
        ).toHaveBeenCalledWith("/vault", "vault");
    });

    it("keeps the current projection when the user cancels", async () => {
        vi.mocked(confirm).mockResolvedValue(false);
        renderComponent(<AIHistoryStorageControl vaultPath="/vault" />);

        fireEvent.click(
            screen.getByRole("switch", {
                name: "Store AI chats inside this vault",
            }),
        );
        await waitFor(() => expect(confirm).toHaveBeenCalled());

        expect(
            useChatStore.getState().changeAiHistoryStorage,
        ).not.toHaveBeenCalled();
        expect(useChatStore.getState().historyStorageStatus).toMatchObject({
            scope: "device",
        });
    });

    it("recovers a missed storage event by refreshing on window focus", async () => {
        const refresh = useChatStore.getState().refreshAiHistoryStorageStatus;
        renderComponent(<AIHistoryStorageControl vaultPath="/vault" />);
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

        window.dispatchEvent(new Event("focus"));

        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    });

    it("passes the explicitly selected orphan namespace to recovery", async () => {
        useChatStore.setState({
            historyStorageStatus: {
                vaultKey: "new-vault-key",
                generation: 2,
                status: "ready",
                scope: "device",
                orphanedDeviceHistories: [
                    {
                        vaultKey: "old-vault-key",
                        previousVaultPath: "/old/vault",
                    },
                ],
            },
        });
        renderComponent(<AIHistoryStorageControl vaultPath="/vault" />);

        expect(
            screen.getByRole("combobox", { name: "Previous vault path" }),
        ).toHaveValue("old-vault-key");
        fireEvent.click(
            screen.getByRole("button", { name: "Import to this device" }),
        );

        await waitFor(() =>
            expect(
                useChatStore.getState().changeAiHistoryStorage,
            ).toHaveBeenCalledWith("/vault", "device", "old-vault-key"),
        );
    });

    it("shows only the reveal roots supplied by the backend", async () => {
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === "ai_reveal_history_recovery_root") {
                return { path: "/previous-local-history" };
            }
            return {
                reason: "multiple_local_roots",
                message: "Manual recovery required.",
                canReconcile: false,
                conflictingSessionIds: [],
                conflictingAttachmentIds: [],
                roots: [
                    {
                        id: "previous_device",
                        label: "Previous local data",
                        hasData: true,
                    },
                    {
                        id: "device",
                        label: "Current device data",
                        hasData: false,
                    },
                    {
                        id: "vault",
                        label: "Current vault data",
                        hasData: true,
                    },
                ],
            };
        });
        useChatStore.setState({
            historyStorageStatus: {
                vaultKey: "vault-key",
                generation: 2,
                status: "recovery_required",
                details: {
                    reason: "multiple_local_roots",
                    message: "Manual recovery required.",
                    canReconcile: false,
                    conflictingSessionIds: [],
                    conflictingAttachmentIds: [],
                    renamedDeviceHistory: false,
                },
            },
        });

        renderComponent(<AIHistoryStorageControl vaultPath="/vault" />);

        expect(
            screen.queryByRole("button", { name: "Use this device" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Use this vault" }),
        ).not.toBeInTheDocument();
        expect(
            await screen.findByRole("button", {
                name: "Reveal Previous local data",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reveal Current vault data" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Reveal Current device data" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Export diagnostic" }),
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Reveal Previous local data" }),
        );
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith(
                "ai_reveal_history_recovery_root",
                { vaultPath: "/vault", root: "previous_device" },
            ),
        );
        await waitFor(() =>
            expect(revealItemInDir).toHaveBeenCalledWith(
                "/previous-local-history",
            ),
        );
    });
});
