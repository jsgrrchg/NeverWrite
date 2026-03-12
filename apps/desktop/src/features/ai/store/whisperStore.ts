import { create } from "zustand";
import {
    whisperListModels,
    whisperGetStatus,
    whisperDownloadModel,
    whisperDeleteModel,
    whisperSetSelectedModel,
    whisperSetEnabled,
    listenToWhisperDownloadProgress,
    listenToWhisperDownloadComplete,
    listenToWhisperDownloadError,
    type WhisperModelDto,
    type WhisperStatusDto,
} from "../api";

interface WhisperStore {
    models: WhisperModelDto[];
    status: WhisperStatusDto | null;
    downloadProgress: Record<string, number>; // model_id -> 0..1
    downloadingModelId: string | null;
    error: string | null;

    fetchModels: () => Promise<void>;
    fetchStatus: () => Promise<void>;
    downloadModel: (modelId: string) => Promise<void>;
    deleteModel: (modelId: string) => Promise<void>;
    setSelectedModel: (modelId: string) => Promise<void>;
    setEnabled: (enabled: boolean) => Promise<void>;
}

export const useWhisperStore = create<WhisperStore>()((set, get) => ({
    models: [],
    status: null,
    downloadProgress: {},
    downloadingModelId: null,
    error: null,

    fetchModels: async () => {
        try {
            const models = await whisperListModels();
            set({ models });
        } catch (e) {
            set({ error: String(e) });
        }
    },

    fetchStatus: async () => {
        try {
            const status = await whisperGetStatus();
            set({ status });
        } catch (e) {
            set({ error: String(e) });
        }
    },

    downloadModel: async (modelId) => {
        set({
            downloadingModelId: modelId,
            error: null,
            downloadProgress: { ...get().downloadProgress, [modelId]: 0 },
        });
        try {
            await whisperDownloadModel(modelId);
        } catch (e) {
            set({ downloadingModelId: null, error: String(e) });
        }
    },

    deleteModel: async (modelId) => {
        try {
            await whisperDeleteModel(modelId);
            // Refresh both models and status
            await Promise.all([get().fetchModels(), get().fetchStatus()]);
        } catch (e) {
            set({ error: String(e) });
        }
    },

    setSelectedModel: async (modelId) => {
        try {
            await whisperSetSelectedModel(modelId);
            set((state) => ({
                status: state.status
                    ? { ...state.status, selectedModel: modelId }
                    : null,
            }));
        } catch (e) {
            set({ error: String(e) });
        }
    },

    setEnabled: async (enabled) => {
        try {
            await whisperSetEnabled(enabled);
            set((state) => ({
                status: state.status ? { ...state.status, enabled } : null,
            }));
        } catch (e) {
            set({ error: String(e) });
        }
    },
}));

// Bind event listeners once at module load
let _listenersBound = false;

export function bindWhisperListeners() {
    if (_listenersBound) return;
    _listenersBound = true;

    void listenToWhisperDownloadProgress((payload) => {
        useWhisperStore.setState((state) => ({
            downloadProgress: {
                ...state.downloadProgress,
                [payload.model_id]: payload.progress,
            },
        }));
    });

    void listenToWhisperDownloadComplete((payload) => {
        useWhisperStore.setState((state) => {
            const progress = { ...state.downloadProgress };
            delete progress[payload.model_id];
            return { downloadingModelId: null, downloadProgress: progress };
        });
        // Refresh models and status after download
        void useWhisperStore.getState().fetchModels();
        void useWhisperStore.getState().fetchStatus();
    });

    void listenToWhisperDownloadError((payload) => {
        useWhisperStore.setState((state) => {
            const progress = { ...state.downloadProgress };
            delete progress[payload.model_id];
            return {
                downloadingModelId: null,
                downloadProgress: progress,
                error: payload.error,
            };
        });
    });
}
