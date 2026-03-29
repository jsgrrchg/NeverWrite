import { type LanguageSupport } from "@codemirror/language";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    loadCodeLanguageSupport,
    loadMarkdownCodeLanguageSupport,
} from "./codeLanguage";

function useLoadedLanguageSupport(
    loader: (() => Promise<LanguageSupport | null>) | null,
) {
    const [languageSupport, setLanguageSupport] =
        useState<LanguageSupport | null>(null);
    const prevLoaderRef = useRef(loader);

    // Reset during render when loader changes (avoids setState inside effects)
    if (prevLoaderRef.current !== loader) {
        prevLoaderRef.current = loader;
        setLanguageSupport(null);
    }

    useEffect(() => {
        if (!loader) return;

        let cancelled = false;
        void loader().then((support) => {
            if (!cancelled) setLanguageSupport(support);
        });

        return () => {
            cancelled = true;
        };
    }, [loader]);

    // When loader is null, return null directly without needing setState
    return loader ? languageSupport : null;
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
