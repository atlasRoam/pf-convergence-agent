type SessionEntryProjector = (entry: unknown) => unknown[];

type TranscriptSession = {
  messages?: unknown[];
  sessionManager?: {
    getBranch?: () => unknown[];
  };
};

/**
 * Build the display transcript from AgentCore's complete active Session branch.
 *
 * AgentSession.messages is intentionally compaction-aware because it is the
 * model context: after compaction it omits the summarized prefix. The desktop
 * transcript must instead project every entry on the active branch so closing
 * and reopening PFSAA never hides persisted pre-compaction messages.
 */
export function sessionTranscriptMessages(
  session: TranscriptSession,
  projectEntry: SessionEntryProjector | undefined,
): unknown[] {
  const branch = session.sessionManager?.getBranch?.();
  if (!Array.isArray(branch) || typeof projectEntry !== "function") {
    return Array.isArray(session.messages) ? session.messages : [];
  }
  return branch.flatMap((entry) => {
    const messages = projectEntry(entry);
    return Array.isArray(messages) ? messages : [];
  });
}
