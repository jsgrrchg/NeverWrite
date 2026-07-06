import { create } from "zustand";

export interface ClipImportNotice {
    id: string;
    title: string;
    message: string;
    // Optional uppercase eyebrow shown above the title. Defaults to the
    // web-clipper wording so existing callers keep their look.
    heading?: string;
    relativePath?: string;
}

interface ClipImportStore {
    notice: ClipImportNotice | null;
    showNotice: (notice: ClipImportNotice) => void;
    clearNotice: () => void;
}

export const useClipImportStore = create<ClipImportStore>((set) => ({
    notice: null,
    showNotice: (notice) => set({ notice }),
    clearNotice: () => set({ notice: null }),
}));
