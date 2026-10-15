import type { WorkerAdapter } from './base.ts';
import { ZCodeAdapter } from './zcode.ts';
import { BashAdapter } from './bash.ts';
import { CodexAdapter } from './codex.ts';

/** Known adapter names accepted by {@link getAdapter}. `shell` aliases `bash`. */
export const KNOWN_ADAPTERS = ['zcode', 'bash', 'codex'] as const;

/** Raised when dispatch/meta names an adapter that is not registered. */
export class UnknownAdapterError extends Error {
  readonly adapterName: string;

  constructor(adapterName: string) {
    super(
      `unknown adapter: ${adapterName} `
        + `(known: ${KNOWN_ADAPTERS.join(', ')}; shell is an alias of bash)`,
    );
    this.name = 'UnknownAdapterError';
    this.adapterName = adapterName;
  }
}

/** Settlement stub for historical metas with a typo'd adapter — no translate(). */
export function unknownAdapterStub(name: string): WorkerAdapter {
  return {
    name,
    description: `unknown adapter (${name})`,
    buildCommand: () => ({ cmd: 'false', args: [] }),
  };
}

/**
 * Resolve a registered worker adapter. Unknown names fail loud — never fall
 * back to ZCode (a typo like `Codex` must not launch the wrong backend).
 */
export function getAdapter(name: string): WorkerAdapter {
  if (name === 'bash' || name === 'shell') {
    return new BashAdapter();
  }
  if (name === 'codex') {
    return new CodexAdapter();
  }
  if (name === 'zcode') {
    return new ZCodeAdapter();
  }
  throw new UnknownAdapterError(name);
}

/** Like {@link getAdapter}, but soft for reconcile/materialize of old metas. */
export function adapterForSettlement(name: string): WorkerAdapter {
  try {
    return getAdapter(name);
  } catch (err) {
    if (err instanceof UnknownAdapterError) return unknownAdapterStub(name);
    throw err;
  }
}
