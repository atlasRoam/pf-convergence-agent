import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface ShellOutputProps {
  output: string;
  lineCount: number;
  collapsed: boolean;
  outputId: string;
  label: string;
  focusable: boolean;
}

function terminalTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  return {
    background: styles.backgroundColor,
    foreground: styles.color,
    cursor: styles.color,
    selectionBackground: styles.getPropertyValue("--accent-soft").trim() || styles.color,
  };
}

export function ShellOutput({ output, lineCount, collapsed, outputId, label, focusable }: ShellOutputProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let terminal: XTermTerminal | null = null;
    let fitAddon: XTermFitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    setTerminalReady(false);

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, fitModule]) => {
      if (disposed || !host.isConnected) return;
      const instance = new xterm.Terminal({
        allowTransparency: false,
        convertEol: true,
        cursorBlink: false,
        cursorInactiveStyle: "none",
        disableStdin: true,
        fontFamily: getComputedStyle(host).fontFamily,
        fontSize: 11,
        lineHeight: 1.55,
        scrollOnUserInput: false,
        scrollback: 5_000,
        screenReaderMode: true,
        tabStopWidth: 8,
        theme: terminalTheme(host),
      });
      const addon = new fitModule.FitAddon();
      terminal = instance;
      fitAddon = addon;
      instance.loadAddon(addon);
      instance.open(host);

      const fit = () => {
        if (host.isConnected) addon.fit();
      };
      fit();
      instance.write(output, () => instance.scrollToTop());

      resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
      resizeObserver?.observe(host);

      const themeRoot = host.closest<HTMLElement>(".app-shell") ?? document.documentElement;
      themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
        instance.options.theme = terminalTheme(host);
      });
      themeObserver?.observe(themeRoot, { attributes: true, attributeFilter: ["class"] });
      setTerminalReady(true);
    }).catch(() => {
      // The plain-text fallback stays visible if the optional terminal chunk
      // cannot load, so command output never degrades to a blank panel.
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      fitAddon?.dispose();
      terminal?.dispose();
      fitAddon = null;
      terminal = null;
      setTerminalReady(false);
    };
  }, [output]);

  const style = { "--shell-output-lines": Math.max(1, lineCount) } as CSSProperties;
  return <div
    ref={hostRef}
    id={outputId}
    className={`shell-command-output-terminal ${collapsed ? "collapsed" : ""}`}
    style={style}
    role="region"
    aria-label={label}
    tabIndex={focusable ? 0 : undefined}
  >
    {!terminalReady && <pre className="shell-command-output-fallback">{output}</pre>}
  </div>;
}
