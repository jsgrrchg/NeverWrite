import { useLayoutEffect, useRef, useState } from "react";

export function useElementWidth<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(entries => {
            const next = entries[0]?.contentRect.width;
            if (next !== undefined) setWidth(next);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { ref, width };
}
