// Capture full stack traces for debugging deep recursion / stack overflow
(Error as ErrorConstructor & { stackTraceLimit?: number }).stackTraceLimit = 300;

import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

interface RootErrorBoundaryState {
    error: Error | null;
    componentStack: string | null;
}

class RootErrorBoundary extends Component<
    { children: ReactNode },
    RootErrorBoundaryState
> {
    state: RootErrorBoundaryState = { error: null, componentStack: null };

    static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
        return { error, componentStack: null };
    }

    componentDidCatch(error: Error, info: { componentStack?: string | null }) {
        console.error("Root render error:", error, info);
        this.setState({ componentStack: info.componentStack ?? null });
    }

    render() {
        if (!this.state.error) {
            return this.props.children;
        }

        return (
            <div
                style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                    background: "var(--bg-primary)",
                    color: "var(--text-primary)",
                }}
            >
                <div
                    style={{
                        width: "min(720px, 100%)",
                        border: "1px solid var(--border)",
                        borderRadius: 14,
                        padding: 20,
                        background: "var(--bg-secondary)",
                        boxShadow: "var(--shadow-soft)",
                    }}
                >
                    <div
                        style={{
                            fontSize: 16,
                            fontWeight: 700,
                            marginBottom: 8,
                        }}
                    >
                        UI render error
                    </div>
                    <div
                        style={{
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: "#ef4444",
                            marginBottom: 12,
                            fontFamily:
                                '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
                        }}
                    >
                        {this.state.error.message}
                    </div>
                    {this.state.componentStack && (
                        <pre
                            style={{
                                margin: "0 0 12px",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: "var(--text-secondary)",
                                fontFamily:
                                    '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
                            }}
                        >
                            {this.state.componentStack.trim()}
                        </pre>
                    )}
                    <div
                        style={{
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: "var(--text-secondary)",
                            marginBottom: 12,
                        }}
                    >
                        The app hit a runtime error while rendering. The message
                        below should help isolate the failing component.
                    </div>
                    <pre
                        style={{
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            fontSize: 12,
                            lineHeight: 1.5,
                            color: "var(--text-primary)",
                            fontFamily:
                                '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
                        }}
                    >
                        {this.state.error.stack || this.state.error.message}
                    </pre>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            marginTop: 16,
                            height: 32,
                            padding: "0 12px",
                            borderRadius: 8,
                            border: "1px solid var(--border)",
                            background: "var(--bg-primary)",
                            color: "var(--text-primary)",
                            cursor: "pointer",
                        }}
                    >
                        Reload App
                    </button>
                </div>
            </div>
        );
    }
}

createRoot(document.getElementById("root")!).render(
    <RootErrorBoundary>
        <App />
    </RootErrorBoundary>,
);
