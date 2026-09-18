import { beforeEach, describe, expect, it } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { safeStorageClear } from "../../../app/utils/safeStorage";
import { getArchiveIdentity, isSessionArchived, readArchivedChats, useArchivedChatsStore } from "./archivedChatsStore";
import type { AIChatSession } from "../types";

const session = (sessionId: string, extra: Partial<AIChatSession> = {}) => ({ sessionId, historySessionId: sessionId, ...extra }) as AIChatSession;
describe("archived chats", () => {
    beforeEach(() => {
        safeStorageClear();
        useVaultStore.setState({ vaultPath: "/archive-vault" });
        useArchivedChatsStore.setState({ vaultPath: "/archive-vault", entries: {} });
    });
    it("persists reversible archive timestamps without conversation content", () => {
        useArchivedChatsStore.getState().archive("history");
        const entry = useArchivedChatsStore.getState().entries.history;
        expect(entry.archivedAt).toBeGreaterThan(0);
        expect(readArchivedChats("/archive-vault")).toEqual({ history: entry });
        useArchivedChatsStore.getState().unarchive("history");
        expect(readArchivedChats("/archive-vault")).toEqual({});
    });
    it("isolates vaults and restores metadata on return", () => {
        useArchivedChatsStore.getState().archive("same-id");
        useVaultStore.setState({ vaultPath: "/other" });
        expect(useArchivedChatsStore.getState().isArchived("same-id")).toBe(false);
        useVaultStore.setState({ vaultPath: "/archive-vault" });
        expect(useArchivedChatsStore.getState().isArchived("same-id")).toBe(true);
    });
    it("preserves recoverable identities on partial or failed discovery", () => {
        useArchivedChatsStore.getState().archive("saved");
        useArchivedChatsStore.getState().reconcile([], false);
        expect(useArchivedChatsStore.getState().isArchived("saved")).toBe(true);
    });
    it("reconciles pending identities and inherits archive through ancestors", () => {
        useArchivedChatsStore.getState().archive("pending:root");
        useArchivedChatsStore.getState().replaceSessionId("pending:root", "durable");
        const root = session("runtime", { historySessionId: "durable" });
        const child = session("child", { parentSessionId: "durable" });
        const grandchild = session("grandchild", { parentSessionId: "child" });
        const sessions = { runtime: root, child, grandchild };
        expect(getArchiveIdentity(root)).toBe("durable");
        expect(isSessionArchived(grandchild, sessions, useArchivedChatsStore.getState().entries)).toBe(true);
        expect(isSessionArchived(session("fork"), sessions, useArchivedChatsStore.getState().entries)).toBe(false);
        expect(useArchivedChatsStore.getState().isArchived("pending:root")).toBe(false);
    });
});
