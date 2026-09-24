import { createAssistantMessageEventStream, fauxAssistantMessage, type Usage } from "@pfsaa/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("Branch summary extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists extension-provided summary usage in session totals", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({
						summary: {
							summary: "Summary provided by extension",
							usage,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		const sourceId = harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });
		const summaryEntry = result.summaryEntry;

		expect(summaryEntry?.type).toBe("branch_summary");
		expect(summaryEntry?.parentId).toBeNull();
		expect(summaryEntry?.fromId).toBe(sourceId);
		expect(summaryEntry?.fromHook).toBe(true);
		expect(summaryEntry?.summary).toBe("Summary provided by extension");
		expect(summaryEntry?.usage).toEqual(usage);

		const stats = harness.session.getSessionStats();
		expect(stats.tokens).toEqual({ input: 12, output: 22, cacheRead: 30, cacheWrite: 40, total: 104 });
		expect(stats.cost).toBe(1);
	});

	it("does not invoke provider request extension hooks for built-in branch summaries", async () => {
		let providerRequestHookCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event) => {
						providerRequestHookCalls++;
						return event.payload;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("branch summary without provider hooks"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.summary).toContain("branch summary without provider hooks");
		expect(providerRequestHookCalls).toBe(0);
	});
});
