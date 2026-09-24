export type AgentRunReservation = {
  started: Promise<boolean>;
  finished: Promise<void>;
  markStarted: (started?: boolean) => void;
  markFinished: () => void;
};

type PromptImage = { type: "image"; data: string; mimeType: string };
type QueueDelivery = "steer" | "followUp";
type PromptSession = {
  isStreaming: boolean;
  isCompacting?: boolean;
  extensionRunner?: { getRegisteredCommands?: () => Array<{ invocationName?: string; name?: string }> };
  steer: (text: string, images?: PromptImage[]) => Promise<void>;
  followUp: (text: string, images?: PromptImage[]) => Promise<void>;
};

export function createAgentRunReservation(): AgentRunReservation {
  let markStarted!: (started?: boolean) => void;
  let markFinished!: () => void;
  const started = new Promise<boolean>((resolve) => { markStarted = (value = true) => resolve(value); });
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  return { started, finished, markStarted, markFinished };
}

export async function waitForReservedAgentRun(reservation: AgentRunReservation, isStreaming: () => boolean): Promise<void> {
  const started = await reservation.started;
  if (!started || !isStreaming()) await reservation.finished;
}

export type ManualCompactionQueueEntry = {
  id: string;
  text: string;
  images: PromptImage[];
  delivery: QueueDelivery;
  order: number;
};

/**
 * AgentCore's native steer/follow-up queues are consumed by an active agent run.
 * Manual compaction ends without one, so prompts entered while it is running
 * must be staged until compaction completes and a new run can consume them.
 */
export class ManualCompactionPromptQueue {
  private active = new Set<string>();
  private entries = new Map<string, ManualCompactionQueueEntry[]>();
  private nextOrder = 0;

  begin(key: string): void {
    this.active.add(key);
    this.entries.set(key, []);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  enqueue(key: string, entry: Omit<ManualCompactionQueueEntry, "order">): ManualCompactionQueueEntry {
    if (!this.active.has(key)) throw new Error("Manual compaction queue is not active");
    const queued = { ...entry, images: [...entry.images], order: this.nextOrder++ };
    this.entries.set(key, [...(this.entries.get(key) ?? []), queued]);
    return queued;
  }

  list(key: string): ManualCompactionQueueEntry[] {
    return [...(this.entries.get(key) ?? [])].sort((a, b) => a.order - b.order);
  }

  edit(key: string, id: string, text: string, images: PromptImage[]): boolean {
    const entries = this.entries.get(key);
    const index = entries?.findIndex((entry) => entry.id === id) ?? -1;
    if (!entries || index < 0) return false;
    entries[index] = { ...entries[index]!, text, images: [...images] };
    return true;
  }

  delete(key: string, id: string): boolean {
    const entries = this.entries.get(key);
    const index = entries?.findIndex((entry) => entry.id === id) ?? -1;
    if (!entries || index < 0) return false;
    entries.splice(index, 1);
    return true;
  }

  promote(key: string, followUpIndex: number): boolean {
    const entries = this.list(key);
    const selected = entries.filter((entry) => entry.delivery === "followUp")[followUpIndex];
    if (!selected) return false;
    selected.delivery = "steer";
    selected.order = Math.min(...entries.filter((entry) => entry.delivery === "steer").map((entry) => entry.order), selected.order) - 1;
    this.entries.set(key, entries);
    return true;
  }

  clear(key: string): void {
    this.entries.set(key, []);
  }

  drain(key: string): ManualCompactionQueueEntry[] {
    const entries = this.list(key);
    this.active.delete(key);
    this.entries.delete(key);
    return entries;
  }

  dispose(key: string): void {
    this.active.delete(key);
    this.entries.delete(key);
  }
}

export function isExtensionCommand(session: PromptSession, text: string): boolean {
  if (!text.startsWith("/")) return false;
  const commandName = text.slice(1).split(/\s/, 1)[0];
  return Boolean(commandName && session.extensionRunner?.getRegisteredCommands?.().some((command) => (command.invocationName ?? command.name) === commandName));
}

export async function queuePromptDuringCompaction(
  session: PromptSession,
  text: string,
  images: PromptImage[] | undefined,
  delivery: QueueDelivery,
): Promise<boolean> {
  if (!session.isCompacting || session.isStreaming || isExtensionCommand(session, text)) return false;
  if (delivery === "followUp") await session.followUp(text, images);
  else await session.steer(text, images);
  return true;
}
