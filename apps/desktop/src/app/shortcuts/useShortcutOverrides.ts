import { useEffect, useState } from "react";
import {
    readShortcutOverrides,
    subscribeShortcutOverrides,
    type ShortcutOverrides,
} from "./preferences";

export function useShortcutOverrides(): ShortcutOverrides {
    const [overrides, setOverrides] = useState(readShortcutOverrides);

    useEffect(() => {
        const unsubscribe = subscribeShortcutOverrides(setOverrides);
        setOverrides(readShortcutOverrides());
        return unsubscribe;
    }, []);

    return overrides;
}
