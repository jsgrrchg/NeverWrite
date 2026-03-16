import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GraphMode = "global" | "overview" | "local";
export type GraphQualityMode =
    | "cinematic"
    | "balanced"
    | "large-vault"
    | "overview";
export type GraphQualitySetting = "auto" | GraphQualityMode;
export type GraphLayoutStrategy =
    | "force"
    | "preset"
    | "overview-packed"
    | "clustered";
export type GraphRendererMode = "2d" | "3d";

export interface GraphGroup {
    id: string;
    name: string;
    query: string;
    color: string;
}

export interface GraphSettings {
    // Mode
    graphMode: GraphMode;
    rendererMode: GraphRendererMode;
    localDepth: number;
    qualityMode: GraphQualitySetting;
    layoutStrategy: GraphLayoutStrategy;
    defaultModeByVault: Record<string, GraphMode>;
    // Forces
    centerForce: number;
    repelForce: number;
    linkForce: number;
    linkDistance: number;
    // Display
    nodeSize: number;
    linkThickness: number;
    textFadeThreshold: number;
    arrows: boolean;
    glowIntensity: number;
    maxGlobalNodes: number;
    maxGlobalLinks: number;
    maxOverviewNodes: number;
    maxOverviewLinks: number;
    maxLocalNodes: number;
    maxLocalLinks: number;
    // Filters
    searchFilter: string;
    showOrphans: boolean;
    showTagNodes: boolean;
    showAttachmentNodes: boolean;
    // Groups (ordered by priority — first match wins)
    groups: GraphGroup[];
    // Panel state
    panelOpen: boolean;
}

interface GraphSettingsStore extends GraphSettings {
    set: <K extends keyof GraphSettings>(
        key: K,
        value: GraphSettings[K],
    ) => void;
    togglePanel: () => void;
    addGroup: (group: GraphGroup) => void;
    updateGroup: (id: string, patch: Partial<Omit<GraphGroup, "id">>) => void;
    removeGroup: (id: string) => void;
    moveGroup: (id: string, direction: "up" | "down") => void;
    setVaultDefaultMode: (vaultPath: string, mode: GraphMode) => void;
}

const defaults: GraphSettings = {
    graphMode: "global",
    rendererMode: "2d",
    localDepth: 2,
    qualityMode: "auto",
    layoutStrategy: "preset",
    defaultModeByVault: {},
    centerForce: 0.3,
    repelForce: 80,
    linkForce: 0.3,
    linkDistance: 60,
    nodeSize: 3,
    linkThickness: 0.5,
    textFadeThreshold: 0.6,
    arrows: false,
    glowIntensity: 50,
    maxGlobalNodes: 8_000,
    maxGlobalLinks: 24_000,
    maxOverviewNodes: 400,
    maxOverviewLinks: 1_200,
    maxLocalNodes: 2_500,
    maxLocalLinks: 12_000,
    searchFilter: "",
    showOrphans: true,
    showTagNodes: false,
    showAttachmentNodes: false,
    groups: [],
    panelOpen: false,
};

export const useGraphSettingsStore = create<GraphSettingsStore>()(
    persist(
        (set) => ({
            ...defaults,
            set: (key, value) => set({ [key]: value }),
            togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
            addGroup: (group) => set((s) => ({ groups: [...s.groups, group] })),
            updateGroup: (id, patch) =>
                set((s) => ({
                    groups: s.groups.map((g) =>
                        g.id === id ? { ...g, ...patch } : g,
                    ),
                })),
            removeGroup: (id) =>
                set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
            moveGroup: (id, direction) =>
                set((s) => {
                    const groups = [...s.groups];
                    const idx = groups.findIndex((g) => g.id === id);
                    if (idx < 0) return s;
                    const swap = direction === "up" ? idx - 1 : idx + 1;
                    if (swap < 0 || swap >= groups.length) return s;
                    [groups[idx], groups[swap]] = [groups[swap], groups[idx]];
                    return { groups };
                }),
            setVaultDefaultMode: (vaultPath, mode) =>
                set((s) => ({
                    defaultModeByVault: {
                        ...s.defaultModeByVault,
                        [vaultPath]: mode,
                    },
                })),
        }),
        { name: "vault-graph-settings" },
    ),
);
