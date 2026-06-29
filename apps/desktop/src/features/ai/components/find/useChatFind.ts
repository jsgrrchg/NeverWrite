import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
    applyChatFindHighlights,
    buildRangesForQuery,
    clearChatFindHighlights,
    setActiveChatFindHighlight,
} from "./chatFindHighlights";

interface UseChatFindArgs {
    ownerId: string;
    containerRef: RefObject<HTMLElement | null>;
    query: string;
    caseSensitive: boolean;
    enabled: boolean;
}

interface UseChatFindResult {
    total: number;
    /** 0-based index of the active match; -1 when there are no matches. */
    activeIndex: number;
    goNext: () => void;
    goPrev: () => void;
}

const REBUILD_DEBOUNCE_MS = 150;

/**
 * Drives "find in chat": builds Ranges for `query` inside the scroll container,
 * registers them as CSS highlights, keeps them in sync while the agent streams,
 * and centers the active match on navigation. All DOM-level work is delegated to
 * chatFindHighlights; this hook owns lifecycle, debouncing and the active cursor.
 */
export function useChatFind({
    ownerId,
    containerRef,
    query,
    caseSensitive,
    enabled,
}: UseChatFindArgs): UseChatFindResult {
    const rangesRef = useRef<Range[]>([]);
    const activeIndexRef = useRef(-1);
    const [total, setTotal] = useState(0);
    const [activeIndex, setActiveIndexState] = useState(-1);

    const setActive = useCallback((next: number) => {
        activeIndexRef.current = next;
        setActiveIndexState(next);
    }, []);

    const scrollToActive = useCallback(() => {
        const container = containerRef.current;
        const ranges = rangesRef.current;
        const idx = activeIndexRef.current;
        if (!container || idx < 0 || idx >= ranges.length) return;
        const range = ranges[idx];
        const rect = range.getBoundingClientRect();
        if (rect.height === 0 && rect.width === 0) {
            range.startContainer.parentElement?.scrollIntoView({
                block: "center",
                behavior: "smooth",
            });
            return;
        }
        const containerRect = container.getBoundingClientRect();
        const delta =
            rect.top -
            containerRect.top -
            (container.clientHeight / 2 - rect.height / 2);
        container.scrollTo({
            top: container.scrollTop + delta,
            behavior: "smooth",
        });
    }, [containerRef]);

    // Core: rebuild ranges + highlights. `preserveActive` keeps the current
    // cursor (used while streaming); otherwise it resets to the first match.
    const rebuild = useCallback(
        (preserveActive: boolean) => {
            const container = containerRef.current;
            if (!enabled || !container || !query) {
                rangesRef.current = [];
                clearChatFindHighlights(ownerId);
                setTotal(0);
                setActive(-1);
                return;
            }
            const ranges = buildRangesForQuery(container, query, caseSensitive);
            rangesRef.current = ranges;
            setTotal(ranges.length);
            let next: number;
            if (ranges.length === 0) {
                next = -1;
            } else if (preserveActive) {
                next = Math.min(
                    Math.max(activeIndexRef.current, 0),
                    ranges.length - 1,
                );
            } else {
                next = 0;
            }
            setActive(next);
            applyChatFindHighlights(ownerId, ranges, next);
        },
        [containerRef, enabled, ownerId, query, caseSensitive, setActive],
    );

    // Fresh search: react to query / case / enabled changes. Clears immediately
    // when empty or disabled; debounces while the user is typing.
    useEffect(() => {
        if (!enabled || !query) {
            rebuild(false);
            return;
        }
        const timer = window.setTimeout(() => {
            rebuild(false);
            scrollToActive();
        }, REBUILD_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, query, caseSensitive, rebuild, scrollToActive]);

    // Streaming invalidation: the agent rewrites/append DOM nodes, which voids the
    // old Ranges. Recompute (preserving the cursor, without stealing scroll).
    useEffect(() => {
        if (!enabled || !query) return;
        const container = containerRef.current;
        if (!container) return;
        let timer = 0;
        const schedule = () => {
            if (timer) return;
            timer = window.setTimeout(() => {
                timer = 0;
                rebuild(true);
            }, REBUILD_DEBOUNCE_MS);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        return () => {
            observer.disconnect();
            if (timer) window.clearTimeout(timer);
        };
    }, [enabled, query, caseSensitive, containerRef, rebuild]);

    // Safety net: always drop this finder instance's document-wide highlights.
    useEffect(() => () => clearChatFindHighlights(ownerId), [ownerId]);

    const move = useCallback(
        (step: number) => {
            const ranges = rangesRef.current;
            if (ranges.length === 0) return;
            const next =
                (activeIndexRef.current + step + ranges.length) % ranges.length;
            setActive(next);
            setActiveChatFindHighlight(ownerId, ranges[next]);
            scrollToActive();
        },
        [ownerId, scrollToActive, setActive],
    );

    const goNext = useCallback(() => move(1), [move]);
    const goPrev = useCallback(() => move(-1), [move]);

    return { total, activeIndex, goNext, goPrev };
}
