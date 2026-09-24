import { fauxAssistantMessage } from "@pfsaa/ai";
import { describe, expect, it } from "vitest";
import { userMsg } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("tree navigation during an active response", () => {
	it("rejects navigation without changing the active leaf", async () => {
		const harness = await createHarness();
		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		let navigationResult: unknown;
		let leafUnchanged = false;

		try {
			// Navigate from inside the response factory, while the run is active.
			harness.setResponses([
				async () => {
					const activeLeafId = harness.sessionManager.getLeafId();
					navigationResult = await harness.session
						.navigateTree(targetId, { summarize: false })
						.catch((error) => error);
					leafUnchanged = activeLeafId !== targetId && harness.sessionManager.getLeafId() === activeLeafId;
					return fauxAssistantMessage("response");
				},
			]);
			await harness.session.prompt("second");

			expect(navigationResult).toEqual(new Error("请等待当前响应完成后，再导航会话树。"));
			expect(leafUnchanged).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
