import { useEffect, useRef, useState } from "react";

export function useInlineRename<T extends string>() {
    const [editingKey, setEditingKey] = useState<T | null>(null);
    const [editValue, setEditValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const skipCommitRef = useRef(false);

    useEffect(() => {
        if (editingKey === null) return;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [editingKey]);

    function startEditing(key: T, value: string) {
        skipCommitRef.current = false;
        setEditingKey(key);
        setEditValue(value);
    }

    function cancelEditing() {
        skipCommitRef.current = true;
        setEditingKey(null);
    }

    function commitEditing(onCommit: (key: T, value: string | null) => void) {
        const key = editingKey;
        if (key === null) {
            skipCommitRef.current = false;
            return;
        }
        if (skipCommitRef.current) {
            skipCommitRef.current = false;
            return;
        }
        const trimmed = editValue.trim();
        skipCommitRef.current = true;
        onCommit(key, trimmed || null);
        setEditingKey(null);
    }

    return {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    };
}
