import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
} from "@pfsaa/telemetry";
import { type Context, getTelemetryContext, withTelemetryContext } from "./context.ts";

export type {
	AttributeValue,
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@pfsaa/telemetry";

export const AI_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"agentcore.ai.request": {
			description: "One logical request to an AI provider",
			parents: { kind: "any" },
			startAttributes: {
				"agentcore.ai.operation": {
					type: "string",
					required: true,
					values: ["stream", "fetch_deferred", "cancel_deferred", "generate_images"],
					description: "Logical provider operation",
				},
				"agentcore.ai.provider": {
					type: "string",
					required: true,
					description: "Selected provider id",
				},
				"agentcore.ai.model": {
					type: "string",
					required: true,
					description: "Requested model id",
				},
				"agentcore.ai.api": {
					type: "string",
					required: true,
					description: "Provider API id",
				},
				"agentcore.ai.streaming": {
					type: "boolean",
					required: true,
					description: "Whether this operation returns a stream",
				},
				"agentcore.ai.deferred": {
					type: "boolean",
					required: false,
					description: "Whether the operation requests or participates in deferred execution",
				},
			},
			endAttributes: {
				"agentcore.ai.response.model": { type: "string", description: "Concrete response model" },
				"agentcore.ai.response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response id",
				},
				"agentcore.ai.response.stop_reason": {
					type: "string",
					values: ["stop", "length", "tool_use", "error", "aborted", "deferred"],
					description: "Normalized terminal response reason",
				},
				"agentcore.ai.http.status_code": { type: "number", description: "Final HTTP status" },
				"agentcore.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
				"agentcore.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
				"agentcore.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
				"agentcore.ai.usage.cache_write_tokens": {
					type: "number",
					description: "Reported cache-write tokens",
				},
				"agentcore.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens" },
				"agentcore.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
				"agentcore.ai.usage.cost": { type: "number", description: "Reported total cost" },
				"agentcore.ai.stream.chunk_count": { type: "number", description: "Streamed update chunk count" },
				"agentcore.ai.stream.time_to_first_chunk_ms": {
					type: "number",
					description: "Elapsed milliseconds to first update chunk",
				},
				"agentcore.ai.error.type": {
					type: "string",
					cardinality: "low",
					description: "Provider or transport error class",
				},
			},
			status: { default: "ok", errorWhen: "The operation throws or returns an error result" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

export type AiSpanName = TelemetrySchemaSpanName<typeof AI_TELEMETRY_SCHEMA>;
export type AiSpanStartAttributes<Name extends AiSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanEndAttributes<Name extends AiSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanAttributes<Name extends AiSpanName> = AiSpanStartAttributes<Name> & AiSpanEndAttributes<Name>;
export type AiSpanEventName<Name extends AiSpanName> = TelemetrySchemaSpanEventName<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpanEventAttributes<
	Name extends AiSpanName,
	EventName extends AiSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof AI_TELEMETRY_SCHEMA, Name, EventName>;
export type AiTelemetrySpan<Name extends AiSpanName> = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpan = TelemetrySchemaSpanUnion<typeof AI_TELEMETRY_SCHEMA>;

export function startAiSpan<Name extends AiSpanName, const Attributes extends AiSpanStartAttributes<Name>, Result>(
	name: Name,
	attributes: ExactTelemetryAttributes<AiSpanStartAttributes<Name>, Attributes>,
	callback: (span: AiTelemetrySpan<Name>, context: Context) => Result | Promise<Result>,
	context: Context,
): Promise<Result> {
	return getTelemetryContext(context).startSpan({ name, attributes }, (span) =>
		callback(span as AiTelemetrySpan<Name>, withTelemetryContext(span, context)),
	);
}

const HOOK_NAMES = [
	"before_run",
	"before_drive",
	"before_run_end",
	"transform_context",
	"before_request",
	"before_payload",
	"after_response",
	"before_tool",
	"after_tool",
	"before_compaction",
	"before_navigation",
] as const;

const EVENT_TYPES = [
	"run_start",
	"run_resume",
	"run_suspend",
	"operation_abort",
	"run_end",
	"fault",
	"handler_error",
	"turn_start",
	"turn_end",
	"retry_scheduled",
	"retry_start",
	"retry_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"queue_update",
	"value_update",
	"config_update",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"lane_created",
	"usage",
] as const;

const operationStartAttributes = {
	"agentcore.session.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Session id",
	},
	"agentcore.lane.name": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Lane name",
	},
	"agentcore.operation.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Durable operation id",
	},
	"agentcore.operation.recovery": {
		type: "boolean",
		required: true,
		description: "Whether this invocation resumes durable work",
	},
} as const;

const operationErrorAttributes = {
	"agentcore.error.code": {
		type: "string",
		cardinality: "low",
		description: "Stable operation error code",
	},
	"agentcore.error.type": {
		type: "string",
		cardinality: "low",
		description: "Low-cardinality operation error class",
	},
} as const;

export const HARNESS_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"agentcore.harness.run": {
			description: "One admitted in-process run invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"agentcore.operation.kind": {
					type: "string",
					required: true,
					values: ["run"],
					description: "Run operation kind",
				},
			},
			endAttributes: {
				"agentcore.operation.outcome": {
					type: "string",
					values: ["completed", "aborted", "failed", "suspended"],
					description: "Run invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The run fails or throws" },
		},
		"agentcore.harness.compaction": {
			description: "One admitted in-process manual compaction invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"agentcore.operation.kind": {
					type: "string",
					required: true,
					values: ["compaction"],
					description: "Compaction operation kind",
				},
			},
			endAttributes: {
				"agentcore.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Compaction invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The compaction fails or throws" },
		},
		"agentcore.harness.navigation": {
			description: "One admitted in-process navigation invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"agentcore.operation.kind": {
					type: "string",
					required: true,
					values: ["navigation"],
					description: "Navigation operation kind",
				},
			},
			endAttributes: {
				"agentcore.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Navigation invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The navigation fails or throws" },
		},
		"agentcore.harness.checkpoint": {
			description: "One run checkpoint",
			parents: { kind: "spans", spans: ["agentcore.harness.run"] },
			startAttributes: {
				"agentcore.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"agentcore.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"agentcore.checkpoint.kind": {
					type: "string",
					required: true,
					values: ["normal", "abort_reconcile"],
					description: "Checkpoint purpose",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Checkpoint work throws" },
		},
		"agentcore.harness.turn": {
			description: "One assistant response and its tool batch",
			parents: { kind: "spans", spans: ["agentcore.harness.run"] },
			startAttributes: {
				"agentcore.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"agentcore.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"agentcore.turn.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Invocation-local turn id",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Turn work throws" },
		},
		"agentcore.harness.step": {
			description: "One durable retry attempt",
			parents: {
				kind: "spans",
				spans: ["agentcore.harness.turn", "agentcore.harness.checkpoint", "agentcore.harness.compaction", "agentcore.harness.navigation"],
			},
			startAttributes: {
				"agentcore.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"agentcore.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"agentcore.step.kind": {
					type: "string",
					required: true,
					values: ["assistant", "compaction", "branch_summary"],
					description: "Retryable step kind",
				},
				"agentcore.step.attempt": {
					type: "number",
					required: true,
					description: "One-based durable attempt number",
				},
				"agentcore.compaction.reason": {
					type: "string",
					required: false,
					values: ["manual", "threshold", "overflow"],
					description: "Compaction trigger",
				},
			},
			endAttributes: {
				"agentcore.step.outcome": {
					type: "string",
					values: ["succeeded", "retry", "failed", "aborted", "deferred", "overflow"],
					description: "Attempt outcome",
				},
			},
			status: { default: "ok", errorWhen: "The attempt retries, fails, or throws" },
		},
		"agentcore.harness.tool": {
			description: "One raw phase-2 tool execution",
			parents: { kind: "spans", spans: ["agentcore.harness.turn", "agentcore.harness.run"] },
			startAttributes: {
				"agentcore.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"agentcore.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"agentcore.turn.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Invocation-local live turn id",
				},
				"agentcore.tool.name": {
					type: "string",
					required: true,
					description: "Tool name",
				},
				"agentcore.tool.call_id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Tool call id",
				},
				"agentcore.tool.replay": {
					type: "string",
					required: true,
					values: ["never", "safe"],
					description: "Declared replay policy",
				},
				"agentcore.tool.recovery": {
					type: "boolean",
					required: true,
					description: "Whether this is recovery execution",
				},
			},
			endAttributes: {
				"agentcore.tool.is_error": {
					type: "boolean",
					description: "Whether raw phase-2 execution returned an error",
				},
			},
			status: { default: "ok", errorWhen: "Raw phase-2 execution returns an error" },
		},
		"agentcore.harness.hook": {
			description: "One registered hook handler invocation",
			parents: { kind: "any" },
			startAttributes: {
				"agentcore.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"agentcore.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				"agentcore.hook.name": {
					type: "string",
					required: true,
					values: HOOK_NAMES,
					description: "Hook name",
				},
				"agentcore.hook.registration_id": {
					type: "string",
					required: false,
					description: "Optional hook registration metadata",
				},
			},
			endAttributes: {
				"agentcore.hook.outcome": {
					type: "string",
					values: ["completed", "skipped", "blocked", "failed"],
					description: "Handler outcome",
				},
			},
			status: { default: "ok", errorWhen: "The handler throws" },
		},
		"agentcore.harness.sleep": {
			description: "One retry delay",
			parents: {
				kind: "spans",
				spans: [
					"agentcore.harness.run",
					"agentcore.harness.compaction",
					"agentcore.harness.navigation",
					"agentcore.harness.turn",
					"agentcore.harness.checkpoint",
				],
			},
			startAttributes: {
				"agentcore.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"agentcore.sleep.delay_ms": {
					type: "number",
					required: true,
					description: "Requested delay in milliseconds",
				},
			},
			endAttributes: {
				"agentcore.sleep.outcome": {
					type: "string",
					values: ["elapsed", "aborted"],
					description: "Delay outcome",
				},
			},
			status: { default: "ok", errorWhen: "Sleep work throws" },
		},
		"agentcore.harness.event_handler": {
			description: "One passive event listener invocation",
			parents: { kind: "any" },
			startAttributes: {
				"agentcore.event.type": {
					type: "string",
					required: true,
					cardinality: "low",
					values: EVENT_TYPES,
					description: "Delivered harness event type",
				},
				"agentcore.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name for lane-scoped events",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The listener throws" },
		},
		"agentcore.session.write": {
			description: "One committed session transaction",
			parents: { kind: "any" },
			startAttributes: {
				"agentcore.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Session id",
				},
				"agentcore.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name when supplied by the caller",
				},
				"agentcore.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when supplied by the caller",
				},
				"agentcore.session.item_count": {
					type: "number",
					required: true,
					description: "Number of writes in the transaction",
				},
				"agentcore.session.item_kinds": {
					type: "string[]",
					required: true,
					elementValues: ["entry", "usage", "value", "list"],
					description: "Distinct write kinds in the transaction",
				},
			},
			endAttributes: {
				"agentcore.session.first_seq": {
					type: "number",
					description: "First committed sequence in the transaction",
				},
				"agentcore.session.last_seq": {
					type: "number",
					description: "Last committed sequence in the transaction",
				},
			},
			status: { default: "ok", errorWhen: "Storage rejects the transaction" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

/** Combined typed span vocabulary for agent-owned AI-request and harness telemetry. */
export const AGENT_TELEMETRY_SCHEMAS = [AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA] as const;

export type HarnessSpanName = TelemetrySchemaSpanName<typeof HARNESS_TELEMETRY_SCHEMA>;
export type HarnessSpanStartAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEndAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanAttributes<Name extends HarnessSpanName> = HarnessSpanStartAttributes<Name> &
	HarnessSpanEndAttributes<Name>;
export type HarnessSpanEventName<Name extends HarnessSpanName> = TelemetrySchemaSpanEventName<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEventAttributes<
	Name extends HarnessSpanName,
	EventName extends HarnessSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof HARNESS_TELEMETRY_SCHEMA, Name, EventName>;
export type HarnessTelemetrySpan<Name extends HarnessSpanName> = SchemaTelemetrySpan<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpan = TelemetrySchemaSpanUnion<typeof HARNESS_TELEMETRY_SCHEMA>;

export function startHarnessSpan<
	Name extends HarnessSpanName,
	const Attributes extends HarnessSpanStartAttributes<Name>,
	Result,
>(
	name: Name,
	attributes: ExactTelemetryAttributes<HarnessSpanStartAttributes<Name>, Attributes>,
	callback: (span: HarnessTelemetrySpan<Name>, context: Context) => Result | Promise<Result>,
	context: Context,
): Promise<Result> {
	return getTelemetryContext(context).startSpan({ name, attributes }, (span: TelemetrySpan) =>
		callback(span as HarnessTelemetrySpan<Name>, withTelemetryContext(span, context)),
	);
}
