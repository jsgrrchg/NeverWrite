import {
    type CSSProperties,
    type MouseEventHandler,
    type ReactNode,
    useEffect,
    useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getWindowChromeLayout } from "../../app/utils/platform";

const WINDOWS_CONTROL_BUTTON_WIDTH = 38;
const WINDOWS_CONTROLS_WIDTH = WINDOWS_CONTROL_BUTTON_WIDTH * 3;

type WindowControlScope = "window" | "webview";

function getAppWindow(scope: WindowControlScope) {
    return scope === "webview" ? getCurrentWebviewWindow() : getCurrentWindow();
}

function getWindowsControlButtonStyle(): CSSProperties {
    return {
        width: WINDOWS_CONTROL_BUTTON_WIDTH,
        height: "100%",
        border: "none",
        borderRadius: 0,
        background: "transparent",
        color: "color-mix(in srgb, var(--text-primary) 78%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
    };
}

function WindowControls({
    scope,
}: {
    scope: WindowControlScope;
}) {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        const syncMaximized = async () => {
            const appWindow = getAppWindow(scope);
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

        const appWindow = getAppWindow(scope);
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
    }, [scope]);

    const stopMouseDown: MouseEventHandler<HTMLButtonElement> = (event) => {
        event.stopPropagation();
    };

    const handleMinimize = () => {
        const appWindow = getAppWindow(scope);
        if (typeof appWindow.minimize !== "function") return;
        void Promise.resolve(appWindow.minimize()).catch(() => {
            // Ignore unavailable minimize support.
        });
    };

    const handleToggleMaximize = () => {
        const appWindow = getAppWindow(scope);
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
        const appWindow = getAppWindow(scope);
        if (typeof appWindow.close !== "function") return;
        void Promise.resolve(appWindow.close()).catch(() => {
            // Ignore unavailable close support.
        });
    };

    return (
        <div
            data-window-controls="windows"
            className="windows-caption-controls no-drag"
            style={{
                width: WINDOWS_CONTROLS_WIDTH,
                height: "100%",
                display: "flex",
                alignItems: "stretch",
                justifyContent: "flex-end",
                marginLeft: 4,
                flexShrink: 0,
            }}
        >
            <button
                type="button"
                aria-label="Minimize window"
                data-window-control="minimize"
                className="windows-caption-button"
                onMouseDown={stopMouseDown}
                onClick={handleMinimize}
                style={getWindowsControlButtonStyle()}
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                >
                    <path
                        d="M2 5.5h6"
                        stroke="currentColor"
                        strokeWidth="1"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
            <button
                type="button"
                aria-label={isMaximized ? "Restore window" : "Maximize window"}
                data-window-control="maximize"
                className="windows-caption-button"
                onMouseDown={stopMouseDown}
                onClick={handleToggleMaximize}
                style={getWindowsControlButtonStyle()}
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                >
                    {isMaximized ? (
                        <>
                            <rect
                                x="2.2"
                                y="3"
                                width="4.8"
                                height="4.8"
                                stroke="currentColor"
                                strokeWidth="1"
                            />
                            <path
                                d="M3 3V2.2h4.8V7H7"
                                stroke="currentColor"
                                strokeWidth="1"
                                fill="none"
                            />
                        </>
                    ) : (
                        <rect
                            x="2.2"
                            y="2.2"
                            width="5.4"
                            height="5.4"
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
                className="windows-caption-button windows-caption-button-close"
                onMouseDown={stopMouseDown}
                onClick={handleClose}
                style={getWindowsControlButtonStyle()}
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                >
                    <path
                        d="M2.3 2.3l5.4 5.4M7.7 2.3 2.3 7.7"
                        stroke="currentColor"
                        strokeWidth="1"
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
    windowControlScope?: WindowControlScope;
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
    windowControlScope = "window",
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
                {shouldRenderWindowControls && (
                    <WindowControls scope={windowControlScope} />
                )}
            </div>
        </div>
    );
}
