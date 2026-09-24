import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { copy, type Language } from "@pfsaa/i18n";
import { readPfsaaStorage } from "./pfsaa-storage";
import "./styles.css";

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("PFSAA renderer failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const language: Language = readPfsaaStorage("language") === "en" ? "en" : "zh";
    const theme = readPfsaaStorage("theme") === "dark" ? "dark" : "light";
    const t = copy[language];
    return <main className={`app-shell ${theme} platform-overlay fatal-error-shell`} role="alert">
      <section className="fatal-error-card">
        <span className="fatal-error-mark" aria-hidden="true">P</span>
        <h1>{t.rendererCrashTitle}</h1>
        <p>{t.rendererCrashBody}</p>
        <pre>{this.state.error.message}</pre>
        <button className="button primary" onClick={() => window.location.reload()}>{t.reloadApplication}</button>
      </section>
    </main>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);
