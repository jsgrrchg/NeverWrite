import { confirm } from "@neverwrite/runtime";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { useChatStore } from "../store/chatStore";
import { AIHistoryStorageControl } from "./AIHistoryStorageControl";

describe("AIHistoryStorageControl", () => {
    beforeEach(() => {
        vi.mocked(confirm).mockResolvedValue(true);
        useVaultStore.setState({ vaultPath: "/vault" });
        useChatStore.setState({
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
        renderComponent(<AIHistoryStorageControl />);

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
        renderComponent(<AIHistoryStorageControl />);

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
        renderComponent(<AIHistoryStorageControl />);
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
        renderComponent(<AIHistoryStorageControl />);

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

    it("shows conflicting IDs and blocks destructive recovery actions", () => {
        useChatStore.setState({
            historyStorageStatus: {
                vaultKey: "vault-key",
                generation: 2,
                status: "recovery_required",
                details: {
                    reason: "conflicting_roots",
                    message: "Conflicting AI chats require manual resolution.",
                    canReconcile: false,
                    conflictingSessionIds: ["session-a"],
                    conflictingAttachmentIds: [],
                    renamedDeviceHistory: false,
                },
            },
        });

        renderComponent(<AIHistoryStorageControl />);

        expect(screen.getByText("Conflicts: session-a")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Use this device" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Use this vault" }),
        ).not.toBeInTheDocument();
    });
});
