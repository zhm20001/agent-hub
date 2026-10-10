/**
 * Human entry point for the transcript promise: open the original conversation
 * of one dispatched run.
 *
 * This is not a board and not a renderer — it prints what the agent's own
 * storage returned, so a person can read it. The platform keeps no copy.
 *
 *   npm run transcript -- <taskId> [--cli <path/to/zcode.cjs>] [--json]
 *
 * `--cli` (or `ZCODE_CLI_PATH`) must point at an agent CLI entry: a transcript
 * handle is opaque by design, so the platform never records where the agent
 * lives on this machine.
 *
 * @module
 */

import { readResolution } from './detached.ts';
import { TranscriptUnavailableError, readTranscript } from './readback.ts';

const USAGE = 'usage: npm run transcript -- <taskId> [--cli <path/to/zcode.cjs>] [--json]';

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let cliPath: string | undefined;
  let asJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') asJson = true;
    else if (arg === '--cli') cliPath = argv[++i];
    else if (arg.startsWith('--cli=')) cliPath = arg.slice('--cli='.length);
    else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}\n${USAGE}`);
      process.exit(64);
    } else positional.push(arg);
  }

  const taskId = positional[0];
  if (taskId === undefined) {
    console.error(USAGE);
    process.exit(64);
  }

  const record = readResolution(taskId);
  if (record === null) {
    console.error(`no closing record for task ${taskId} (unknown task, or still running)`);
    process.exit(1);
  }

  const ref = record.resolution.transcriptRef;
  if (ref === undefined) {
    console.error(`task ${taskId} has no transcriptRef — this run produced nothing to read`
      + ` (stopCause: ${record.resolution.stopCause ?? 'ended normally'},`
      + ` producedOutput: ${record.observation.producedOutput})`);
    process.exit(2);
  }

  let readback;
  try {
    readback = await readTranscript(ref, cliPath === undefined ? {} : { cliPath });
  } catch (error) {
    if (error instanceof TranscriptUnavailableError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
  if (readback === undefined) {
    console.error(`no readback route for provenance "${ref.provenance}"`);
    process.exit(2);
  }

  // Progress goes to stderr so that `npm run transcript -- <id> > out.txt` yields
  // exactly the transcript.
  console.error(`task ${taskId} · ${ref.provenance}:${ref.handle}`
    + ` · messages=${readback.messages.length} textParts=${readback.textParts.length} chars=${readback.text.length}`);
  process.stdout.write(asJson ? `${JSON.stringify(readback.messages, null, 2)}\n` : `${readback.text}\n`);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
