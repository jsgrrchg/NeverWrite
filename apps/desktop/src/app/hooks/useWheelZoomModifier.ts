import { useEffect, useRef } from "react";

type ModifierRef = { current: boolean };

export function useWheelZoomModifier() {
    const modifierPressedRef = useRef(false);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.key === "Meta" ||
                event.key === "Control" ||
                event.metaKey ||
                event.ctrlKey
            ) {
                modifierPressedRef.current = true;
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            modifierPressedRef.current = event.metaKey || event.ctrlKey;
        };

        const resetModifier = () => {
            modifierPressedRef.current = false;
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                resetModifier();
            }
        };

        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("blur", resetModifier);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("keyup", handleKeyUp, true);
            window.removeEventListener("blur", resetModifier);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, []);

    return modifierPressedRef;
}

export function isWheelZoomGesture(
    event: WheelEvent,
    modifierPressedRef: ModifierRef,
) {
    return event.metaKey || event.ctrlKey || modifierPressedRef.current;
}
