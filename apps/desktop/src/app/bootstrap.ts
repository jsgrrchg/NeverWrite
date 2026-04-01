import { hydrateLayoutStore } from "./store/layoutStore";
import { initializeSettingsStore } from "./store/settingsStore";
import { initializeThemeStore } from "./store/themeStore";
import { initializePerfInstrumentation } from "./utils/perfInstrumentation";
import { applyGhostWindowDocumentState } from "./utils/safeBrowser";
import { initializeChatStoreRuntime } from "../features/ai/store/chatStore";

export function bootstrapApplicationRuntime() {
    applyGhostWindowDocumentState();
    initializePerfInstrumentation();
    hydrateLayoutStore();
    initializeSettingsStore();
    initializeThemeStore();
    initializeChatStoreRuntime();
}
