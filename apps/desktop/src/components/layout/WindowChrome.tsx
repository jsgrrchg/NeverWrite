import {
    type CSSProperties,
    type MouseEventHandler,
    type ReactNode,
    useEffect,
    useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getWindowChromeLayout } from "../../app/utils/platform";

const appWindow = getCurrentWindow();

const WINDOWS_CONTROLS_WIDTH = 138;

function getWindowsControlButtonStyle(
    variant: "default" | "close",
): CSSProperties {
    return {
        width: 46,
        height: 30,
        border: "none",
        borderRadius: 0,
        background: "transparent",
        color:
            variant === "close"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: 0,
    };
}

function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        const syncMaximized = async () => {
            if (typeof appWindow.isMaximized !== "function") return;
            try {
                const maximized = await appWindow.isMaximized();
                if (!disposed) {
                    setIsMaximized(maximized);
                }
            } catch {
                // Ignore unsupported maximize state queries.
            }
        };

        void syncMaximized();

        if (typeof appWindow.onResized === "function") {
            const resizeListener = appWindow.onResized(() => {
                void syncMaximized();
            });

            if (
                resizeListener &&
                typeof (resizeListener as PromiseLike<() => void>).then ===
                    "function"
            ) {
                void resizeListener
                    .then((dispose) => {
                        if (disposed) {
                            dispose();
                            return;
                        }
                        unlisten = dispose;
                    })
                    .catch(() => {
                        // Ignore unavailable resize listeners in tests/platforms.
                    });
            }
        }

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const stopMouseDown: MouseEventHandler<HTMLButtonElement> = (event) => {
        event.stopPropagation();
    };

    const handleMinimize = () => {
        if (typeof appWindow.minimize !== "function") return;
        void Promise.resolve(appWindow.minimize()).catch(() => {
            // Ignore unavailable minimize support.
        });
    };

    const handleToggleMaximize = () => {
        if (typeof appWindow.toggleMaximize !== "function") return;
        void Promise.resolve(appWindow.toggleMaximize())
            .then(async () => {
                if (typeof appWindow.isMaximized !== "function") return;
                const maximized = await appWindow.isMaximized();
                setIsMaximized(maximized);
            })
            .catch(() => {
                // Ignore unavailable maximize support.
            });
    };

    const handleClose = () => {
        if (typeof appWindow.close !== "function") return;
        void Promise.resolve(appWindow.close()).catch(() => {
            // Ignore unavailable close support.
        });
    };

    return (
        <div
            data-window-controls="windows"
            style={{
                width: WINDOWS_CONTROLS_WIDTH,
                height: "100%",
                display: "flex",
                alignItems: "stretch",
                justifyContent: "flex-end",
                marginLeft: 8,
                flexShrink: 0,
            }}
        >
            <button
                type="button"
                aria-label="Minimize window"
                data-window-control="minimize"
                onMouseDown={stopMouseDown}
                onClick={handleMinimize}
                style={getWindowsControlButtonStyle("default")}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                        d="M1.5 5h7"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
            <button
                type="button"
                aria-label={isMaximized ? "Restore window" : "Maximize window"}
                data-window-control="maximize"
                onMouseDown={stopMouseDown}
                onClick={handleToggleMaximize}
                style={getWindowsControlButtonStyle("default")}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    {isMaximized ? (
                        <>
                            <rect
                                x="2.2"
                                y="3.2"
                                width="4.6"
                                height="4.6"
                                stroke="currentColor"
                                strokeWidth="1"
                            />
                            <path
                                d="M3.2 3.2V2.2h4.6v4.6H6.8"
                                stroke="currentColor"
                                strokeWidth="1"
                                fill="none"
                            />
                        </>
                    ) : (
                        <rect
                            x="2.2"
                            y="2.2"
                            width="5.6"
                            height="5.6"
                            stroke="currentColor"
                            strokeWidth="1"
                        />
                    )}
                </svg>
            </button>
            <button
                type="button"
                aria-label="Close window"
                data-window-control="close"
                onMouseDown={stopMouseDown}
                onClick={handleClose}
                style={getWindowsControlButtonStyle("close")}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                        d="M2 2l6 6M8 2L2 8"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
        </div>
    );
}

interface WindowChromeProps {
    children: ReactNode;
    showLeadingInset?: boolean;
    showWindowControls?: boolean;
    onBackgroundMouseDown?: MouseEventHandler<HTMLDivElement>;
    onBackgroundDoubleClick?: MouseEventHandler<HTMLDivElement>;
    onLeadingInsetMouseDown?: MouseEventHandler<HTMLDivElement>;
    onLeadingInsetDoubleClick?: MouseEventHandler<HTMLDivElement>;
    shellStyle?: CSSProperties;
    barStyle?: CSSProperties;
}

export function WindowChrome({
    children,
    showLeadingInset = false,
    showWindowControls = false,
    onBackgroundMouseDown,
    onBackgroundDoubleClick,
    onLeadingInsetMouseDown,
    onLeadingInsetDoubleClick,
    shellStyle,
    barStyle,
}: WindowChromeProps) {
    const layout = getWindowChromeLayout();
    const shouldRenderLeadingInset =
        showLeadingInset && layout.leadingInsetWidth > 0;
    const shouldRenderWindowControls =
        showWindowControls && layout.platform === "windows";

    return (
        <div
            data-window-platform={layout.platform}
            data-window-controls-side={layout.windowControlsSide}
            onMouseDown={onBackgroundMouseDown}
            onDoubleClick={onBackgroundDoubleClick}
            style={{
                paddingTop: layout.titlebarPaddingTop,
                ...shellStyle,
            }}
        >
            <div
                className="flex items-stretch select-none"
                style={{
                    height: 38,
                    cursor: "default",
                    ...barStyle,
                }}
            >
                {shouldRenderLeadingInset && (
                    <div
                        data-window-chrome-leading-inset="true"
                        onMouseDown={onLeadingInsetMouseDown}
                        onDoubleClick={onLeadingInsetDoubleClick}
                        style={{
                            width: layout.leadingInsetWidth,
                            flexShrink: 0,
                        }}
                    />
                )}
                {children}
                {shouldRenderWindowControls && <WindowControls />}
            </div>
        </div>
    );
}
