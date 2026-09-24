import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@pfsaa/telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"agentcore.harness.run",
			"agentcore.harness.compaction",
			"agentcore.harness.navigation",
			"agentcore.harness.checkpoint",
			"agentcore.harness.turn",
			"agentcore.harness.step",
			"agentcore.harness.tool",
			"agentcore.harness.hook",
			"agentcore.harness.sleep",
			"agentcore.harness.event_handler",
			"agentcore.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"agentcore.harness.step",
			{
				"agentcore.lane.name": "main",
				"agentcore.operation.id": "operation",
				"agentcore.step.kind": "assistant",
				"agentcore.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "agentcore.step.outcome": "succeeded" });
				await startChildSpan(
					"agentcore.ai.request",
					{
						"agentcore.ai.operation": "stream",
						"agentcore.ai.provider": "provider",
						"agentcore.ai.model": "model",
						"agentcore.ai.api": "api",
						"agentcore.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "agentcore.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"agentcore.ai.request">;
		type End = AiSpanEndAttributes<"agentcore.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"agentcore.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"agentcore.ai.provider": string;
			"agentcore.ai.model": string;
			"agentcore.ai.api": string;
			"agentcore.ai.streaming": boolean;
			"agentcore.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["agentcore.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startAiSpan(
			"agentcore.ai.request",
			{
				"agentcore.ai.operation": "stream",
				"agentcore.ai.provider": "provider",
				"agentcore.ai.model": "model",
				"agentcore.ai.api": "api",
				"agentcore.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "agentcore.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error agentcore.ai.request declares no span events
				span.addEvent("chunk");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"agentcore.ai.operation": "stream",
				"agentcore.ai.provider": "provider",
				"agentcore.ai.model": "model",
				"agentcore.ai.api": "api",
				"agentcore.ai.streaming": true,
				"agentcore.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan("agentcore.ai.request", extraAttributes, () => {}, context);
			// @ts-expect-error missing required start attributes
			void startAiSpan("agentcore.ai.request", { "agentcore.ai.operation": "stream" }, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"agentcore.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"agentcore.harness.run">;
		type WriteStart = HarnessSpanStartAttributes<"agentcore.session.write">;
		type WriteEnd = HarnessSpanEndAttributes<"agentcore.session.write">;
		expectTypeOf<RunStart["agentcore.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["agentcore.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();
		const writeStart = {
			"agentcore.session.id": "session",
			"agentcore.session.item_count": 2,
			"agentcore.session.item_kinds": ["entry", "value", "list"],
		} satisfies WriteStart;
		const writeEnd = {
			"agentcore.session.first_seq": 1,
			"agentcore.session.last_seq": 2,
		} satisfies WriteEnd;
		expectTypeOf(writeStart["agentcore.session.item_count"]).toEqualTypeOf<number>();
		expectTypeOf(writeEnd["agentcore.session.last_seq"]).toEqualTypeOf<number>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startHarnessSpan(
			"agentcore.harness.run",
			{
				"agentcore.session.id": "session",
				"agentcore.lane.name": "main",
				"agentcore.operation.id": "operation",
				"agentcore.operation.kind": "run",
				"agentcore.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "agentcore.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"agentcore.session.id": "session",
				"agentcore.lane.name": "main",
				"agentcore.operation.id": "operation",
				"agentcore.operation.kind": "run",
				"agentcore.operation.recovery": false,
				"agentcore.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan("agentcore.harness.run", extraRunAttributes, () => {}, context);
			void startHarnessSpan(
				"agentcore.harness.checkpoint",
				{
					"agentcore.lane.name": "main",
					"agentcore.operation.id": "operation",
					"agentcore.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "agentcore.unknown": true });
				},
				context,
			);
			void startHarnessSpan(
				"agentcore.harness.run",
				{
					"agentcore.session.id": "session",
					"agentcore.lane.name": "main",
					"agentcore.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"agentcore.operation.kind": "navigation",
					"agentcore.operation.recovery": false,
				},
				() => {},
				context,
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan("agentcore.harness.run", {}, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
