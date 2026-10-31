import { Component, type ReactNode } from "react";

/**
 * A page that throws while rendering must not blank the whole app. The shell
 * and the nav stay; the page says it hit a problem and offers a reload.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("page failed to render", error);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="card" role="alert">
          <h2>This page hit a problem</h2>
          <p className="muted">{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
