import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Human label for the failing region, shown in the fallback card. */
  label?: string;
  /** When false, render a minimal full-screen fallback (top-level backstop). */
  panel?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors in its subtree so one bad panel cannot
 * white-screen the whole terminal. Each dashboard panel is wrapped in its own
 * boundary (panel=true); a top-level boundary in App.tsx is the backstop.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console for debugging; the UI shows a localized card.
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isPanel = this.props.panel ?? true;
    const label = this.props.label ?? "Panel";

    if (isPanel) {
      return (
        <div className="panel h-full">
          <div className="panel-header">
            <span className="text-accent-red">{label} failed</span>
          </div>
          <div className="panel-body overflow-auto">
            <p className="text-accent-red text-xs mb-2">This panel hit an error and was isolated so the rest of the terminal keeps working.</p>
            <pre className="text-2xs text-terminal-dim whitespace-pre-wrap break-words mb-3">{String(error.message || error)}</pre>
            <button
              onClick={this.reset}
              className="pill border border-terminal-border px-2 py-1 hover:bg-terminal-border/30"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full flex items-center justify-center bg-terminal-bg">
        <div className="panel max-w-lg w-full">
          <div className="panel-header"><span className="text-accent-red">Terminal error</span></div>
          <div className="panel-body">
            <p className="text-accent-red text-sm mb-2">The terminal hit an unexpected error.</p>
            <pre className="text-2xs text-terminal-dim whitespace-pre-wrap break-words mb-3">{String(error.message || error)}</pre>
            <button
              onClick={() => window.location.reload()}
              className="pill border border-terminal-border px-3 py-1 hover:bg-terminal-border/30"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
