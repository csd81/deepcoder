/**
 * `deepcoder flight` — inspect and replay flight-recorder snapshots.
 *
 * The recorder (`src/session/flightRecorder.ts`) captures the EXACT compiled
 * `ChatRequest` for each model call under `.deepcoder/flight/<sessionId>/`,
 * including the ephemeral context the session transcript omits. These commands
 * read those snapshots back — NOT the session transcript — so what you inspect
 * is byte-for-byte (post-redaction) what the model actually saw.
 *
 *   deepcoder flight list <sessionId>
 *   deepcoder flight replay <sessionId> <callIndex> [--live]
 *
 * `replay` prints the reconstituted payload and, only with `--live`, re-issues it
 * to the real provider (otherwise no model call is made — no spend).
 */

import type { Command } from "commander";
import type { ModelProvider } from "../providers/types.js";
import { loadConfig } from "../config/config.js";
import { createProvider } from "../providers/factory.js";
import { listFlightCalls, reconstituteCall } from "../session/flightRecorder.js";

export interface ReplayResult {
  exitCode: number;
}

export async function runFlightList(root: string, sessionId: string): Promise<ReplayResult> {
  let indices: number[];
  try {
    indices = await listFlightCalls(root, sessionId);
  } catch (err) {
    process.stderr.write(`flight list: ${(err as Error).message}\n`);
    return { exitCode: 2 };
  }
  if (indices.length === 0) {
    process.stdout.write(`No recorded calls for session "${sessionId}".\n`);
    return { exitCode: 0 };
  }
  process.stdout.write(`Recorded calls for ${sessionId}: ${indices.join(", ")}\n`);
  return { exitCode: 0 };
}

export async function runFlightReplay(
  root: string,
  sessionId: string,
  callIndex: number,
  opts: { live?: boolean; provider?: ModelProvider } = {},
): Promise<ReplayResult> {
  if (!Number.isInteger(callIndex) || callIndex < 0) {
    process.stderr.write(`flight replay: invalid call index "${callIndex}"\n`);
    return { exitCode: 2 };
  }

  let req;
  try {
    req = await reconstituteCall(root, sessionId, callIndex);
  } catch (err) {
    process.stderr.write(`flight replay: ${(err as Error).message}\n`);
    return { exitCode: 1 };
  }

  process.stdout.write(
    `# call ${callIndex} — model=${req.model}, messages=${req.messages.length}, tools=${req.tools.length}\n`,
  );
  process.stdout.write(JSON.stringify(req.messages, null, 2) + "\n");

  if (opts.live || opts.provider) {
    const provider = opts.provider ?? createProvider(loadConfig());
    const res = await provider.chat({ messages: req.messages, tools: req.tools, model: req.model });
    process.stdout.write(`\n# re-issued response:\n${res.text}\n`);
  }
  return { exitCode: 0 };
}

export function registerFlightCommand(program: Command, deps: { root?: string } = {}): Command {
  const root = deps.root ?? loadConfig().workspaceRoot;

  const flight = program
    .command("flight")
    .description("inspect/replay per-turn flight-recorder snapshots (.deepcoder/flight/)");

  flight
    .command("list <sessionId>")
    .description("list the recorded model-call indices for a session")
    .action(async (sessionId: string) => {
      const res = await runFlightList(root, sessionId);
      process.exit(res.exitCode);
    });

  flight
    .command("replay <sessionId> <callIndex>")
    .description("reconstitute a recorded model call; print the exact payload (use --live to re-issue)")
    .option("--live", "re-issue the payload to the real provider (makes a model call)")
    .action(async (sessionId: string, callIndex: string, o: { live?: boolean }) => {
      const res = await runFlightReplay(root, sessionId, parseInt(callIndex, 10), { live: o.live });
      process.exit(res.exitCode);
    });

  return flight;
}
