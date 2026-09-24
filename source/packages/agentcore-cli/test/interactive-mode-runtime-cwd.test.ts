import { describe, expect, it, vi } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ResumeSessionHost = {
	clearStatusIndicator(): void;
	runtimeHost: {
		switchSession: ReturnType<typeof vi.fn>;
	};
	sessionManager: { getSessionDir(): string };
	fixedRuntimeCwd?: string;
	createProjectTrustContext(cwd: string): ProjectTrustContext;
	showStatus(message: string): void;
	handleFatalRuntimeError(label: string, error: unknown): { cancelled: true };
};

const handleResumeSession = (
	InteractiveMode as unknown as {
		prototype: {
			handleResumeSession(this: ResumeSessionHost, sessionPath: string): Promise<{ cancelled: boolean }>;
		};
	}
).prototype.handleResumeSession;

function createHost(fixedRuntimeCwd?: string): ResumeSessionHost {
	return {
		clearStatusIndicator: vi.fn(),
		runtimeHost: {
			switchSession: vi.fn(async () => ({ cancelled: false })),
		},
		sessionManager: { getSessionDir: () => "/fixed/runtime/.agentcore/sessions" },
		fixedRuntimeCwd,
		createProjectTrustContext: vi.fn(() => ({ mode: "interactive" }) as ProjectTrustContext),
		showStatus: vi.fn(),
		handleFatalRuntimeError: vi.fn(() => ({ cancelled: true })),
	};
}

describe("InteractiveMode 固定产品运行 cwd", () => {
	it("在产品入口会话切换时传递 cwdOverride", async () => {
		const host = createHost("/fixed/runtime");

		await handleResumeSession.call(host, "/sessions/other.jsonl");

		expect(host.runtimeHost.switchSession).toHaveBeenCalledWith(
			"/sessions/other.jsonl",
			expect.objectContaining({
				cwdOverride: "/fixed/runtime",
				sessionDir: "/fixed/runtime/.agentcore/sessions",
			}),
		);
	});

	it("普通 CLI 未设置产品入口合同时保持原有 cwd 语义", async () => {
		const host = createHost();

		await handleResumeSession.call(host, "/sessions/other.jsonl");

		expect(host.runtimeHost.switchSession).toHaveBeenCalledWith(
			"/sessions/other.jsonl",
			expect.objectContaining({ cwdOverride: undefined, sessionDir: undefined }),
		);
	});
});
