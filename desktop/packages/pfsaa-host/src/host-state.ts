import type { SessionChangeReview } from "@pfsaa/contracts";
import type { WorkspaceChangeInspection } from "./session-change-review.js";
import { ManualCompactionPromptQueue, type AgentRunReservation } from "./agent-prompt-coordination.js";

/**
 * Mutable PfsaaHost state is kept in one module so command handlers and lifecycle
 * code can share the same ownership boundary without importing each other's
 * implementation details. The maps are process-local and keyed by the
 * normalized project/session state key supplied by the orchestrator.
 */
export const sessionManagers = new Map<string, any>();
export const sessionFiles = new Map<string, string>();
export const titledSessions = new Set<string>();
export const agentSessions = new Map<string, any>();
export const agentSessionRuntimes = new Map<string, any>();
export const agentSessionPromises = new Map<string, Promise<any>>();
export const agentSessionPackageRevisions = new Map<string, number>();
export const agentSessionRevisions = new Map<string, number>();
export const executionGroupStarts = new Map<string, number>();

export const SESSION_RUN_METADATA_TYPE = "pfsaa.execution-run";
export const LEGACY_SESSION_RUN_METADATA_TYPES = new Set(["pideck.execution-run"]);

export type ActiveChangeReviewSegment = {
  startedAt: number;
  baseline: Promise<WorkspaceChangeInspection>;
  outcome?: SessionChangeReview["outcome"];
};

export type ActiveChangeReviewTracker = {
  current: ActiveChangeReviewSegment;
  persistence: Promise<void>;
  previewRevision: number;
  previewTimer?: ReturnType<typeof setTimeout>;
  previewController?: AbortController;
};

export const activeChangeReviews = new Map<string, ActiveChangeReviewTracker>();
export const pendingChangeReviewWrites = new Set<Promise<void>>();
export const pendingChangeReviewWritesBySession = new Map<string, Set<Promise<void>>>();
export const changeReviewMutationLocks = new Map<string, Promise<void>>();

// AgentSession can enter automatic-compaction preflight before AgentCore reports
// `isStreaming`. Track both boundaries so another request cannot mistake this
// preflight window for an idle Agent.
export const agentRunReservations = new Map<string, AgentRunReservation>();
export const manualCompactionQueues = new ManualCompactionPromptQueue();

export type AuthWaiter = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  beforeResolve?: (value: string) => Promise<void>;
};

export const authWaiters = new Map<string, AuthWaiter>();

export type ActiveProviderLogin = {
  operationId: string;
  providerId: string;
  controller: AbortController;
};

export const activeProviderLogins = new Map<string, ActiveProviderLogin>();
export const activeProviderLoginByProvider = new Map<string, ActiveProviderLogin>();

export const capabilitySessions = new Map<string, any>();
