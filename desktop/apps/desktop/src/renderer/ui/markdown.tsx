import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copy, type Language } from "@pfsaa/i18n";
import { copyText, Icon } from "@pfsaa/ui-system";
import katex from "katex";
import "katex/dist/katex.min.css";

function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (node && typeof node === "object" && "props" in node) return reactNodeText((node as { props?: { children?: ReactNode } }).props?.children);
  return "";
}

function CodeBlock({ children, language }: { children: ReactNode; language: Language }) {
  const [copied, setCopied] = useState(false);
  const t = copy[language];
  async function copyCode() {
    try {
      if (!await copyText(reactNodeText(children).replace(/\n$/, ""))) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  return <div className="code-block"><button type="button" onClick={() => void copyCode()}><Icon name="copy" size={13} />{copied ? t.copiedCode : t.copyCode}</button><pre>{children}</pre></div>;
}

type ResolvedTheme = "light" | "dark";

// Mirrors the resolved theme written to <html> by usePreferences so Mermaid can
// pick a matching palette without threading theme through every call site.
function useResolvedTheme(): ResolvedTheme {
  const read = (): ResolvedTheme =>
    document.documentElement.style.colorScheme === "dark" || document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  const [theme, setTheme] = useState<ResolvedTheme>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function MermaidBlock({ code, language }: { code: string; language: Language }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: theme === "dark" ? "dark" : "default", securityLevel: "strict" });
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        setRendered(true);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code, theme]);
  if (failed) return <CodeBlock language={language}><code>{code}</code></CodeBlock>;
  return <div className={`mermaid-block${rendered ? "" : " mermaid-loading"}`} ref={ref} role="img" aria-label="diagram" />;
}

interface ParsedMath {
  latex: string;
  displayMode: boolean;
}

// Display/inline math delimiters an LLM may emit inside a fenced block.
// Order matters: $$ must be tried before $ so display math wins.
const MATH_DELIMITERS = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

// KaTeX lacks a few operators LLMs use constantly, and sometimes escapes
// characters that need no escaping in math mode. Filling these in is cheaper
// than dropping the whole formula back to a plain code block.
const KATEX_MACROS: Record<string, string> = {
  "\\argmin": "\\operatorname*{arg\\,min}",
  "\\argmax": "\\operatorname*{arg\\,max}",
  "\\*": "*",
};

// Pulls every delimited formula out of a fenced block. Returns null when the
// content is not made up purely of math, so it stays a normal code block.
function extractDelimitedMath(text: string): ParsedMath[] | null {
  const blocks: ParsedMath[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  MATH_DELIMITERS.lastIndex = 0;
  while ((match = MATH_DELIMITERS.exec(text))) {
    // Prose between formulas means this is not a pure math block.
    if (text.slice(cursor, match.index).trim()) return null;
    const [, dollars, bracket, paren, inline] = match;
    const body = dollars ?? bracket ?? paren ?? inline ?? "";
    if (body.trim()) blocks.push({ latex: body.trim(), displayMode: paren === undefined && inline === undefined });
    cursor = match.index + match[0].length;
  }
  if (!blocks.length || text.slice(cursor).trim()) return null;
  return blocks;
}

function parseMathCode(code: string, className: string): ParsedMath[] | null {
  const trimmed = code.trim();
  if (!trimmed) return null;

  // Delimited math wins regardless of the fence language, so ```latex,
  // ```markdown and an untagged fence all behave the same.
  const delimited = extractDelimitedMath(trimmed);
  if (delimited) return delimited;

  // Bare formula body under an explicit ```math / ```latex / ```tex tag.
  if (/language-(math|latex|tex)$/i.test(className)) return [{ latex: trimmed, displayMode: true }];

  return null;
}

function MathBlock({ code, className, language }: { code: string; className: string; language: Language }) {
  const html = useMemo(() => {
    const blocks = parseMathCode(code, className);
    if (!blocks) return null;
    try {
      // throwOnError keeps a broken formula readable as source instead of
      // rendering the entire block as one red KaTeX error blob.
      return blocks
        .map((block) => katex.renderToString(block.latex, { displayMode: block.displayMode, throwOnError: true, trust: false, macros: KATEX_MACROS }))
        .join("");
    } catch {
      return null;
    }
  }, [code, className]);
  if (!html) return <CodeBlock language={language}><code>{code}</code></CodeBlock>;
  return <span className="math-rendered" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Matches a fenced block (closed or still streaming) or an inline code span
// first, so the math rewrite below never touches code. Everything else is a
// TeX-style delimiter that remark-math cannot read on its own.
const CODE_OR_MATH =
  /(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n(?:[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*$|[\s\S]*$)|`[^`\n]+`)|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/gm;

// remark-math only supports dollar delimiters. Many LLMs output TeX-style
// \[...\] / \(...\) instead, so normalize them outside of code regions.
function normalizeMathDelimiters(text: string): string {
  return text.replace(CODE_OR_MATH, (match, code: string | undefined, display: string | undefined, inline: string | undefined) => {
    if (code !== undefined) return match;
    if (display !== undefined) return `$$\n${display.trim()}\n$$`;
    return `$${(inline ?? "").trim()}$`;
  });
}

const MarkdownRenderer = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }, { default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("remark-math"),
    import("rehype-katex"),
  ]);
  return { default: function LoadedMarkdown({ text, language }: { text: string; language: Language }) {
    const normalized = useMemo(() => normalizeMathDelimiters(text), [text]);
    return <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          const codeEl = child as { props?: { className?: string; children?: ReactNode } } | null;
          const cls = codeEl?.props?.className ?? "";
          const code = reactNodeText(codeEl?.props?.children);
          if (typeof cls === "string" && cls.includes("language-mermaid")) {
            return <MermaidBlock code={code} language={language} />;
          }
          if (typeof cls === "string" && parseMathCode(code, cls)) {
            return <MathBlock code={code} className={cls} language={language} />;
          }
          return <CodeBlock language={language}>{children}</CodeBlock>;
        },
        a: ({ children, href, ...props }) => <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >{normalized}</ReactMarkdown>;
  } };
});

export const MarkdownContent = memo(function MarkdownContent({ text, language }: { text: string; language: Language }) {
  return <div className="markdown-content"><Suspense fallback={<p>{text}</p>}><MarkdownRenderer text={text} language={language} /></Suspense></div>;
});
