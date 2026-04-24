import {
    type CSSProperties,
    type MouseEventHandler,
    type ReactNode,
} from "react";
import { getWindowChromeLayout } from "../../app/utils/platform";

// On Windows, the caption buttons are painted by Electron's native
// `titleBarOverlay`, not by React — so this component only reserves the
// drag region and optional macOS leading inset, and never renders custom
// min/max/close buttons.
interface WindowChromeProps {
    children: ReactNode;
    showLeadingInset?: boolean;
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
                className="drag flex items-stretch select-none"
                style={{
                    height: 34,
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
            </div>
        </div>
    );
}
