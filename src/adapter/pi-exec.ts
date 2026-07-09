// Real ExecDriver using node:child_process. Trivial wrapper; the adapter
// layer (src/adapter/index.ts) checks exit codes and throws on failure.

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type { ExecDriver, ExecOpts, ExecResult } from "./driver.ts";

const execAsync = promisify(execCb);

export class NodeExecDriver implements ExecDriver {
	private readonly cwd?: string;

	constructor(cwd?: string) {
		this.cwd = cwd;
	}

	async run(opts: ExecOpts): Promise<ExecResult> {
		const cwd = opts.cwd ?? this.cwd;
		try {
			const p = await execAsync(opts.cmd, {
				encoding: "utf8",
				...(cwd ? { cwd } : {}),
			});
			return {
				stdout: (p.stdout ?? "").trimEnd(),
				stderr: (p.stderr ?? "").trimEnd(),
				code: 0,
			};
		} catch (e: any) {
			return {
				stdout: (e.stdout ?? "").trimEnd(),
				stderr: (e.stderr ?? "").trimEnd(),
				code: e.code ?? 1,
			};
		}
	}
}
