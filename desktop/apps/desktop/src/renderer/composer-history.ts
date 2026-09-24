type ComposerHistoryDirection = "previous" | "next";

type SessionComposerHistory = {
  entries: string[];
  index: number;
  draft: string;
  hasRawSubmission: boolean;
};

export type ComposerHistoryNavigation = {
  handled: boolean;
  value?: string;
};

function entriesFromMessages(messages: readonly string[]): string[] {
  const chronological: string[] = [];
  for (const value of messages) {
    const text = value.trim();
    if (text && chronological[chronological.length - 1] !== text) chronological.push(text);
  }
  return chronological.slice(-100).reverse();
}
/** Keeps the exact submitted editor text, matching AgentCore TUI's in-memory input history. */
export class ComposerHistory {
  private readonly sessions = new Map<string, SessionComposerHistory>();

  private session(taskId: string, persistedMessages: readonly string[]): SessionComposerHistory {
    let state = this.sessions.get(taskId);
    if (!state) {
      state = { entries: entriesFromMessages(persistedMessages), index: -1, draft: "", hasRawSubmission: false };
      this.sessions.set(taskId, state);
    } else if (!state.hasRawSubmission && state.index === -1) {
      state.entries = entriesFromMessages(persistedMessages);
    }
    return state;
  }

  add(taskId: string, value: string, persistedMessages: readonly string[]): void {
    const text = value.trim();
    if (!text) return;
    const state = this.session(taskId, persistedMessages);
    if (state.entries[0] !== text) state.entries.unshift(text);
    if (state.entries.length > 100) state.entries.length = 100;
    state.hasRawSubmission = true;
    state.index = -1;
    state.draft = "";
  }

  navigate(taskId: string, direction: ComposerHistoryDirection, draft: string, persistedMessages: readonly string[]): ComposerHistoryNavigation {
    const state = this.session(taskId, persistedMessages);
    if (state.entries.length === 0) return { handled: false };

    if (direction === "previous") {
      if (state.index === -1) state.draft = draft;
      state.index = Math.min(state.entries.length - 1, state.index + 1);
      return { handled: true, value: state.entries[state.index] };
    }

    if (state.index === -1) return { handled: false };
    state.index -= 1;
    return { handled: true, value: state.index === -1 ? state.draft : state.entries[state.index] };
  }

  resetNavigation(taskId: string): void {
    const state = this.sessions.get(taskId);
    if (!state) return;
    state.index = -1;
    state.draft = "";
  }
}
