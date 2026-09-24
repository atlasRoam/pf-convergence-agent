import type { SessionTreeEntryRole, SessionTreeEntrySummary, SessionTreeSnapshot } from "@pfsaa/contracts";
import { parseSkillInvocation } from "@pfsaa/domain";

const MAX_TREE_ENTRIES = 5_000;
const MAX_PREVIEW_LENGTH = 500;

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is { type: string; text?: string } => Boolean(part && typeof part === "object" && "type" in part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function clipped(value: unknown): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > MAX_PREVIEW_LENGTH ? `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : normalized;
}

function messagePreview(content: unknown): string {
  const text = textContent(content);
  const skill = parseSkillInvocation(text);
  if (!skill) return clipped(text);
  return clipped([`/skill:${skill.name}`, skill.userMessage].filter(Boolean).join(" "));
}

function entryRole(entry: any): SessionTreeEntryRole {
  if (entry?.type !== "message") return entry?.type === "custom_message" ? "system" : "other";
  const role = entry.message?.role;
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") return role;
  if (role === "toolResult") return "tool";
  return "other";
}

function entryPreview(entry: any): string {
  if (entry?.type === "message") {
    if (entry.message?.role === "toolResult") return clipped(entry.message?.content ?? entry.message?.result);
    return messagePreview(entry.message?.content);
  }
  if (entry?.type === "custom_message") return clipped(textContent(entry.content));
  if (entry?.type === "compaction" || entry?.type === "branch_summary") return clipped(entry.summary);
  if (entry?.type === "model_change") return clipped(`${entry.provider ?? ""}/${entry.modelId ?? ""}`.replace(/^\//, ""));
  if (entry?.type === "thinking_level_change") return clipped(entry.thinkingLevel);
  if (entry?.type === "session_info") return clipped(entry.name);
  if (entry?.type === "custom") return clipped(entry.customType);
  if (entry?.type === "label") return clipped(entry.label);
  return "";
}

export function buildSessionTreeSnapshot(session: any): SessionTreeSnapshot {
  const manager = session.sessionManager;
  const roots = manager.getTree?.() ?? [];
  const leafId = manager.getLeafId?.() ?? null;
  const forkableIds = new Set<string>((session.getUserMessagesForForking?.() ?? []).map((message: any) => message.entryId));
  const activeIds = new Set<string>();
  let activeId = leafId;
  while (activeId) {
    if (activeIds.has(activeId)) break;
    activeIds.add(activeId);
    activeId = manager.getEntry?.(activeId)?.parentId ?? null;
  }

  const entries: SessionTreeEntrySummary[] = [];
  const stack = [...roots].reverse().map((node) => ({ node, depth: 0 }));
  while (stack.length && entries.length < MAX_TREE_ENTRIES) {
    const { node, depth } = stack.pop()!;
    const entry = node?.entry;
    if (!entry?.id) continue;
    const children = Array.isArray(node.children) ? node.children : [];
    entries.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: String(entry.type ?? "unknown"),
      role: entryRole(entry),
      preview: entryPreview(entry),
      ...(typeof node.label === "string" && node.label.trim() ? { label: clipped(node.label) } : {}),
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      depth,
      childCount: children.length,
      active: activeIds.has(entry.id),
      current: entry.id === leafId,
      forkable: forkableIds.has(entry.id),
    });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], depth: depth + 1 });
  }
  return { entries, leafId, truncated: stack.length > 0 };
}
