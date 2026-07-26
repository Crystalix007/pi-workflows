import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	FanoutError,
	RpcSubagentDriver,
	type EventBus,
} from "../src/adapter/rpc-driver.ts";

class FakeEventBus implements EventBus {
	private readonly listeners = new Map<string, (data: unknown) => void>();
	requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	asyncDir = "";
	status = "State: complete";

	on(event: string, handler: (data: unknown) => void): () => void {
		this.listeners.set(event, handler);
		return () => this.listeners.delete(event);
	}

	emit(event: string, data: unknown): void {
		if (event !== "subagents:rpc:v1:request") return;
		const request = data as {
			requestId: string;
			method: string;
			params: Record<string, unknown>;
		};
		this.requests.push({ method: request.method, params: request.params });
		const reply = this.listeners.get(
			`subagents:rpc:v1:reply:${request.requestId}`,
		);
		if (!reply) throw new Error("missing RPC reply listener");
		if (request.method === "spawn") {
			reply({
				success: true,
				data: { details: { id: "fanout-1", asyncDir: this.asyncDir } },
			});
		} else if (request.method === "status") {
			reply({ success: true, data: { text: this.status } });
		}
	}
}

describe("RpcSubagentDriver fanout", () => {
	it("uses native tasks mode and preserves input order for repeated roles", async () => {
		const asyncDir = mkdtempSync(join(tmpdir(), "wf-fanout-"));
		try {
			writeFileSync(
				join(asyncDir, "status.json"),
				JSON.stringify({
					runId: "fanout-1",
					state: "complete",
					steps: [
						{
							agent: "reviewer",
							recentOutput: ["truncated first"],
							status: "complete",
							structuredOutput: { position: 1 },
						},
						{
							agent: "reviewer",
							recentOutput: ["truncated second"],
							status: "complete",
							structuredOutput: { position: 2 },
						},
					],
				}),
			);
			writeFileSync(
				join(asyncDir, "output-0.log"),
				"Task: first\n---\n**Output:**\nfull first",
			);
			writeFileSync(
				join(asyncDir, "output-1.log"),
				"Task: second\n---\n**Output:**\nfull second",
			);
			const bus = new FakeEventBus();
			bus.asyncDir = asyncDir;
			const driver = new RpcSubagentDriver(bus, 1, 1_000);
			driver.sleep = async () => {};

			const result = await driver.fanout({
				context: "fresh",
				concurrency: 2,
				tasks: [
					{ agent: "reviewer", task: "first", model: "provider/one" },
					{ agent: "reviewer", task: "second", model: "provider/two" },
				],
			});

			assert.deepStrictEqual(bus.requests[0].params, {
				tasks: [
					{ agent: "reviewer", task: "first", model: "provider/one" },
					{ agent: "reviewer", task: "second", model: "provider/two" },
				],
				context: "fresh",
				async: true,
				concurrency: 2,
			});
			assert.deepStrictEqual(
				result.results.map((child) => child.text),
				["full first", "full second"],
			);
			assert.deepStrictEqual(
				result.results.map((child) => child.details),
				[{ position: 1 }, { position: 2 }],
			);
			assert.deepStrictEqual(
				result.results.map((child) => child.index),
				[0, 1],
			);
		} finally {
			rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("halts paused fan-outs using the durable lifecycle state", async () => {
		const asyncDir = mkdtempSync(join(tmpdir(), "wf-fanout-"));
		try {
			writeFileSync(
				join(asyncDir, "status.json"),
				JSON.stringify({
					state: "paused",
					steps: [
						{
							agent: "reviewer",
							status: "paused",
							recentOutput: ["interrupted"],
						},
					],
				}),
			);
			const bus = new FakeEventBus();
			bus.asyncDir = asyncDir;
			bus.status = "State: running";
			const driver = new RpcSubagentDriver(bus, 1, 1_000);
			driver.sleep = async () => {};

			await assert.rejects(
				driver.fanout({ tasks: [{ agent: "reviewer", task: "review" }] }),
				(error: unknown) => {
					assert(error instanceof FanoutError);
					assert.strictEqual(error.result.results[0].status, "paused");
					return true;
				},
			);
		} finally {
			rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("halts after collecting partial failures", async () => {
		const asyncDir = mkdtempSync(join(tmpdir(), "wf-fanout-"));
		try {
			writeFileSync(
				join(asyncDir, "result.json"),
				JSON.stringify({
					results: [
						{ agent: "reviewer", output: "ok", state: "complete" },
						{
							agent: "reviewer",
							summary: "bad",
							state: "failed",
							success: false,
						},
					],
				}),
			);
			const bus = new FakeEventBus();
			bus.asyncDir = asyncDir;
			const driver = new RpcSubagentDriver(bus, 1, 1_000);
			driver.sleep = async () => {};

			await assert.rejects(
				driver.fanout({
					tasks: [
						{ agent: "reviewer", task: "one" },
						{ agent: "reviewer", task: "two" },
					],
				}),
				(error: unknown) => {
					assert(error instanceof FanoutError);
					assert.strictEqual(error.result.results[0].ok, true);
					assert.strictEqual(error.result.results[1].ok, false);
					return true;
				},
			);
		} finally {
			rmSync(asyncDir, { recursive: true, force: true });
		}
	});
});
