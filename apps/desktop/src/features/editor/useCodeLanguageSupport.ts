import { type LanguageSupport } from "@codemirror/language";
import { useEffect, useMemo, useState } from "react";
import {
    loadCodeLanguageSupport,
    loadMarkdownCodeLanguageSupport,
} from "./codeLanguage";

function useLoadedLanguageSupport(
    loader: (() => Promise<LanguageSupport | null>) | null,
) {
    const [{ resolvedLoader, languageSupport }, setResolvedSupport] = useState<{
        resolvedLoader: (() => Promise<LanguageSupport | null>) | null;
        languageSupport: LanguageSupport | null;
    }>({
        resolvedLoader: null,
        languageSupport: null,
    });

    useEffect(() => {
        if (!loader) return;

        let cancelled = false;
        void loader().then((support) => {
            if (!cancelled) {
                setResolvedSupport({
                    resolvedLoader: loader,
                    languageSupport: support,
                });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [loader]);

    // Drop stale async results when the loader identity changes between renders.
    return loader && resolvedLoader === loader ? languageSupport : null;
}

export function useCodeLanguageSupport(
    path: string | null | undefined,
    mimeType: string | null,
) {
    const loader = useMemo(() => {
        if (!path) {
            return null;
        }
        return () => loadCodeLanguageSupport(path, mimeType);
    }, [mimeType, path]);

    return useLoadedLanguageSupport(loader);
}

export function useMarkdownCodeLanguageSupport(
    info: string | null | undefined,
) {
    const loader = useMemo(() => {
        const trimmed = info?.trim();
        if (!trimmed) {
            return null;
        }
        return () => loadMarkdownCodeLanguageSupport(trimmed);
    }, [info]);

    return useLoadedLanguageSupport(loader);
}
