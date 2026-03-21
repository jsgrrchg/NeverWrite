import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewFileItem } from "../diff/editedFilesPresentationModel";

export function useEditedFilesReviewExpansion(items: ReviewFileItem[]) {
    const itemKeys = useMemo(
        () => items.map((item) => item.file.identityKey),
        [items],
    );
    const knownKeysRef = useRef(new Set(itemKeys));
    const [expandedKeys, setExpandedKeys] = useState(() => new Set(itemKeys));

    useEffect(() => {
        setExpandedKeys((prev) => {
            const next = new Set<string>();
            const itemKeySet = new Set(itemKeys);
            const knownKeys = knownKeysRef.current;

            for (const key of prev) {
                if (itemKeySet.has(key)) {
                    next.add(key);
                }
            }

            for (const key of itemKeys) {
                if (!knownKeys.has(key)) {
                    next.add(key);
                }
            }

            knownKeysRef.current = itemKeySet;
            return setsEqual(prev, next) ? prev : next;
        });
    }, [itemKeys]);

    const toggleFile = useCallback((key: string) => {
        setExpandedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    const expandAll = useCallback(() => {
        setExpandedKeys(new Set(items.map((item) => item.file.identityKey)));
    }, [items]);

    const collapseAll = useCallback(() => {
        setExpandedKeys(new Set());
    }, []);

    return {
        expandedKeys,
        toggleFile,
        expandAll,
        collapseAll,
        allExpanded: items.length > 0 && expandedKeys.size === items.length,
    };
}

function setsEqual(a: Set<string>, b: Set<string>) {
    if (a.size !== b.size) {
        return false;
    }

    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }

    return true;
}
