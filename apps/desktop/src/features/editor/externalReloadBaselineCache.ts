import type { Tab } from "../../app/store/editorStore";
import { collectLiveFilePathsFromTabs } from "./filePathStateCache";

type ExternalReloadBaselineEntry = {
    beforeContent: string;
    afterSignature: string;
    updatedAt: number;
};

const EXTERNAL_RELOAD_BASELINE_MAX_AGE_MS = 30_000;
const externalReloadBaselineByPath = new Map<
    string,
    ExternalReloadBaselineEntry
>();

function normalizeBaselineText(text: string) {
    return text.replace(/\r/g, "");
}

function buildBaselineSignature(text: string) {
    const normalized = normalizeBaselineText(text);
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

function isExpired(entry: ExternalReloadBaselineEntry, now = Date.now()) {
    return now - entry.updatedAt > EXTERNAL_RELOAD_BASELINE_MAX_AGE_MS;
}

export function rememberExternalReloadBaseline(
    relativePath: string,
    beforeContent: string,
    afterContent: string,
) {
    externalReloadBaselineByPath.set(relativePath, {
        beforeContent,
        afterSignature: buildBaselineSignature(afterContent),
        updatedAt: Date.now(),
    });
}

export function getExternalReloadBaselineCandidate(
    relativePath: string,
    currentContent: string,
) {
    const entry = externalReloadBaselineByPath.get(relativePath);
    if (!entry) {
        return null;
    }

    if (isExpired(entry)) {
        externalReloadBaselineByPath.delete(relativePath);
        return null;
    }

    if (entry.afterSignature !== buildBaselineSignature(currentContent)) {
        return null;
    }

    return entry.beforeContent;
}

export function pruneExternalReloadBaselines(tabs: readonly Tab[]) {
    const liveFilePaths = collectLiveFilePathsFromTabs(tabs);
    for (const relativePath of externalReloadBaselineByPath.keys()) {
        if (!liveFilePaths.has(relativePath)) {
            externalReloadBaselineByPath.delete(relativePath);
        }
    }
}

export function clearExternalReloadBaselines() {
    externalReloadBaselineByPath.clear();
}

export function resetExternalReloadBaselinesForTests() {
    clearExternalReloadBaselines();
}
