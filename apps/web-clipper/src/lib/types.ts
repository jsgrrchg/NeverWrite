import type { ClipContentMode } from "../entrypoints/clip-window/components/ClipForm";
import type { ClipMetadata } from "./clipper-contract";

export interface VaultConfig {
    id: string;
    name: string;
    path: string;
    defaultFolder: string;
    folderHints: string[];
}

export interface ClipperTemplate {
    id: string;
    name: string;
    body: string;
    vaultId: string;
    domain: string;
}

export interface ClipHistoryEntry {
    id: string;
    requestId: string;
    createdAt: string;
    title: string;
    url: string;
    domain: string;
    folder: string;
    tags: string[];
    method: "desktop-api" | "deep-link-inline" | "deep-link-clipboard";
    status: "saved" | "handoff";
    contentMode: ClipContentMode;
    markdown: string;
    metadata: ClipMetadata;
    vaultId: string;
    vaultName: string;
    templateId: string | null;
}

export interface ClipperSettings {
    vaults: VaultConfig[];
    activeVaultIndex: number;
    clipSelectedOnly: boolean;
    useClipboard: boolean;
    defaultTemplate: string;
    recentTags: string[];
    recentFoldersByVault: Record<string, string[]>;
    templates: ClipperTemplate[];
    clipHistory: ClipHistoryEntry[];
}

export type { ClipData } from "./clipper-contract";
