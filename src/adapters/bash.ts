import type { WorkerAdapter, AdapterCommandSpec, AdapterCommandResult } from './base.ts';
import type { AdapterRawOutput, AdapterTranslation } from './contract.ts';

export class BashAdapter implements WorkerAdapter {
  readonly name = 'bash';
  readonly description = 'Standard POSIX Bash shell subagent for autonomous CLI routines';

  /** No launch preconditions: the shell has no provider registry to locate. */
  readonly preconditions = [] as const;

  checkPreconditions(): void {
    // Nothing to check — declared empty above, and kept honest by doing nothing.
  }

  buildCommand(spec: AdapterCommandSpec): AdapterCommandResult {
    return {
      cmd: 'bash',
      args: ['-c', spec.prompt],
      env: { ...process.env },
    };
  }

  /**
   * The shell has no structured result: its whole output is its answer, and
   * whitespace counts as no output at all (contract §5). No session, no
   * transcript, no usage — the honest minimum, and the reason the contract's
   * `bash` sample is the acceptance means.
   */
  translate(raw: AdapterRawOutput): AdapterTranslation {
    const hasContent = raw.output.replace(/\s+/g, '').length > 0;
    return {
      producedOutput: hasContent,
      finalText: hasContent ? { kind: 'text', value: raw.output } : { kind: 'empty' },
    };
  }
}
