import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReviewFileItem } from "./editedFilesPresentationModel";

export function useEditedFilesReviewExpansion(items: ReviewFileItem[]) {
    const initialExpanded = useMemo(() => {
        if (items.length === 0) return new Set<string>();
        if (items.length <= 5) {
            return new Set(items.map((item) => item.entry.identityKey));
        }
        return new Set([items[0].entry.identityKey]);
    }, [items]);
    const [expandedKeys, setExpandedKeys] = useState(initialExpanded);

    useEffect(() => {
        setExpandedKeys(initialExpanded);
    }, [initialExpanded]);

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
        setExpandedKeys(new Set(items.map((item) => item.entry.identityKey)));
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
