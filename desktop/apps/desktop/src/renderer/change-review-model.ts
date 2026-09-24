import type { SessionChangeFile } from "@pfsaa/contracts";

export type DiffLine = {
  key: string;
  kind: "context" | "addition" | "deletion" | "hunk" | "meta";
  oldLine?: number;
  newLine?: number;
  marker: string;
  text: string;
  hunkIndex: number;
  whitespaceOnly?: boolean;
};

export type SideBySideDiffRow = {
  key: string;
  kind: "pair" | "hunk" | "meta";
  oldLine?: DiffLine;
  newLine?: DiffLine;
  text?: string;
  oldOmittedLines?: number;
  newOmittedLines?: number;
  hunkIndex: number;
};

export type ChangeFileTreeNode = ChangeFileTreeDirectory | ChangeFileTreeFile;
export type ChangeFileTreeDirectory = {
  kind: "directory";
  name: string;
  path: string;
  children: ChangeFileTreeNode[];
  fileCount: number;
  additions: number;
  deletions: number;
};
export type ChangeFileTreeFile = {
  kind: "file";
  name: string;
  path: string;
  file: SessionChangeFile;
};

type MutableDirectory = {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: ChangeFileTreeFile[];
};

export type ReviewTreeKeyboardAction = {
  focusKey?: string;
  expandKey?: string;
  collapseKey?: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function markWhitespaceOnly(lines: DiffLine[]): void {
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== "deletion") { index += 1; continue; }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === "deletion") deletions.push(lines[index++]);
    while (lines[index]?.kind === "addition") additions.push(lines[index++]);
    if (deletions.length !== additions.length || deletions.length === 0) continue;
    if (deletions.every((line, pairIndex) => normalizeWhitespace(line.text) === normalizeWhitespace(additions[pairIndex]?.text ?? ""))) {
      for (const line of [...deletions, ...additions]) line.whitespaceOnly = true;
    }
  }
}

export function parseUnifiedPatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkIndex = -1;
  for (const [index, rawLine] of patch.split("\n").entries()) {
    if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ") || /^={3,}$/.test(rawLine)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunkIndex += 1;
      lines.push({ key: `hunk-${index}`, kind: "hunk", marker: "", text: rawLine, hunkIndex });
      continue;
    }
    if (rawLine.startsWith("+")) {
      lines.push({ key: `add-${index}`, kind: "addition", newLine, marker: "+", text: rawLine.slice(1), hunkIndex });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      lines.push({ key: `delete-${index}`, kind: "deletion", oldLine, marker: "−", text: rawLine.slice(1), hunkIndex });
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      lines.push({ key: `context-${index}`, kind: "context", oldLine, newLine, marker: "", text: rawLine.slice(1), hunkIndex });
      oldLine += 1;
      newLine += 1;
    } else if (rawLine) {
      lines.push({ key: `meta-${index}`, kind: "meta", marker: "", text: rawLine, hunkIndex });
    }
  }
  markWhitespaceOnly(lines);
  return lines;
}

export function sideBySideRows(lines: DiffLine[]): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let previousOldLine: number | undefined;
  let previousNewLine: number | undefined;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line) break;
    if (line.kind === "hunk") {
      const starts = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
      const oldStart = starts ? Number(starts[1]) : undefined;
      const newStart = starts ? Number(starts[2]) : undefined;
      const oldOmittedLines = oldStart !== undefined && previousOldLine !== undefined
        ? Math.max(0, oldStart - previousOldLine - 1)
        : 0;
      const newOmittedLines = newStart !== undefined && previousNewLine !== undefined
        ? Math.max(0, newStart - previousNewLine - 1)
        : 0;
      rows.push({
        key: line.key,
        kind: line.kind,
        text: line.text,
        ...(oldOmittedLines ? { oldOmittedLines } : {}),
        ...(newOmittedLines ? { newOmittedLines } : {}),
        hunkIndex: line.hunkIndex,
      });
      index += 1;
      continue;
    }
    if (line.kind === "meta") {
      rows.push({ key: line.key, kind: line.kind, text: line.text, hunkIndex: line.hunkIndex });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ key: `pair-${line.key}`, kind: "pair", oldLine: line, newLine: line, hunkIndex: line.hunkIndex });
      previousOldLine = line.oldLine;
      previousNewLine = line.newLine;
      index += 1;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === "deletion") deletions.push(lines[index++]);
    while (lines[index]?.kind === "addition") additions.push(lines[index++]);
    const count = Math.max(deletions.length, additions.length);
    for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
      const oldLine = deletions[pairIndex];
      const newLine = additions[pairIndex];
      rows.push({
        key: `pair-${oldLine?.key ?? ""}-${newLine?.key ?? ""}`,
        kind: "pair",
        oldLine,
        newLine,
        hunkIndex: oldLine?.hunkIndex ?? newLine?.hunkIndex ?? -1,
      });
      if (oldLine?.oldLine !== undefined) previousOldLine = oldLine.oldLine;
      if (newLine?.newLine !== undefined) previousNewLine = newLine.newLine;
    }
  }
  return rows;
}

export function buildChangeFileTree(files: SessionChangeFile[], query = ""): ChangeFileTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFiles = normalizedQuery
    ? files.filter((file) => `${file.previousPath ?? ""}\n${file.path}`.toLocaleLowerCase().includes(normalizedQuery))
    : files;
  const root: MutableDirectory = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of visibleFiles) {
    const parts = file.path.replaceAll("\\", "/").split("/").filter(Boolean);
    if (!parts.length) continue;
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const childPath = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = { name: part, path: childPath, directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ kind: "file", name: parts.at(-1) ?? file.path, path: file.path, file });
  }

  const finalize = (directory: MutableDirectory): ChangeFileTreeNode[] => {
    const directories = [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map<ChangeFileTreeDirectory>((child) => {
        const children = finalize(child);
        return {
          kind: "directory",
          name: child.name,
          path: child.path,
          children,
          fileCount: children.reduce((count, node) => count + (node.kind === "file" ? 1 : node.fileCount), 0),
          additions: children.reduce((count, node) => count + (node.kind === "file" ? node.file.additions : node.additions), 0),
          deletions: children.reduce((count, node) => count + (node.kind === "file" ? node.file.deletions : node.deletions), 0),
        };
      });
    const directFiles = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
    return [...directories, ...directFiles];
  };
  return finalize(root);
}

export function directoryAncestors(filePath: string): string[] {
  const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function compactDirectory(directory: ChangeFileTreeDirectory): { directory: ChangeFileTreeDirectory; label: string } {
  const labels = [directory.name];
  let current = directory;
  while (current.children.length === 1 && current.children[0]?.kind === "directory") {
    current = current.children[0];
    labels.push(current.name);
  }
  return { directory: current, label: labels.join("/") };
}

export function allDirectoryPaths(nodes: ChangeFileTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (items: ChangeFileTreeNode[]) => {
    for (const item of items) {
      if (item.kind !== "directory") continue;
      const compacted = compactDirectory(item).directory;
      paths.push(compacted.path);
      visit(compacted.children);
    }
  };
  visit(nodes);
  return paths;
}

export function reviewTreeKeyboardAction(
  visibleKeys: string[],
  currentKey: string,
  key: string,
  kind: "directory" | "file",
  expanded: boolean,
  parentKey?: string,
  firstChildKey?: string,
): ReviewTreeKeyboardAction {
  const currentIndex = Math.max(0, visibleKeys.indexOf(currentKey));
  if (key === "ArrowDown") return { focusKey: visibleKeys[Math.min(visibleKeys.length - 1, currentIndex + 1)] };
  if (key === "ArrowUp") return { focusKey: visibleKeys[Math.max(0, currentIndex - 1)] };
  if (key === "Home") return { focusKey: visibleKeys[0] };
  if (key === "End") return { focusKey: visibleKeys.at(-1) };
  if (key === "ArrowRight" && kind === "directory") return expanded ? { focusKey: firstChildKey } : { expandKey: currentKey };
  if (key === "ArrowLeft") {
    if (kind === "directory" && expanded) return { collapseKey: currentKey };
    return { focusKey: parentKey };
  }
  return {};
}

export type CodeToken = { text: string; kind?: "comment" | "string" | "number" | "keyword" };

const CODE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements", "import", "in", "interface", "let", "new", "null", "of", "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "with", "yield",
]);

export function tokenizeCodeLine(value: string): CodeToken[] {
  const pattern = /(^\s*#.*$|\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;
  const tokens: CodeToken[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: value.slice(cursor, index) });
    const text = match[0];
    const kind = text.startsWith("//") || text.startsWith("#")
      ? "comment"
      : /^["'`]/.test(text)
        ? "string"
        : /^\d/.test(text)
          ? "number"
          : CODE_KEYWORDS.has(text) ? "keyword" : undefined;
    tokens.push({ text, ...(kind ? { kind } : {}) });
    cursor = index + text.length;
    if (kind === "comment") break;
  }
  if (cursor < value.length) tokens.push({ text: value.slice(cursor) });
  return tokens.length ? tokens : [{ text: value }];
}
