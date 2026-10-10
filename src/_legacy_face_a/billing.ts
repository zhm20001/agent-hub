/**
 * The read-only billing weak-check: before the first dispatch of a process,
 * read the newest `model_usage` row of the zcode CLI's own SQLite billing
 * database and refuse dispatch when its `provider_id` is none of the
 * configured accepted providers. Deliberately weak — a historical row does not prove
 * the next call's provider — so a drift is repaired by the probe closure in
 * ZCODE-CLI-DELEGATION.md, never by an automatic probe here: this check opens
 * the database read-only, writes nothing, and issues no API calls.
 * @module @deepseek-ai/dsh-subagent-zcode/billing
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The billing check refused dispatch; the message carries the probe-closure guidance. */
export class BillingSelfCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingSelfCheckError'
  }
}

/**
 * The zcode CLI billing database path. `ZCODE_DB_PATH` overrides it for
 * relocated zcode homes and for tests; the default is the CLI's own storage
 * contract (`~/.zcode/cli/db/db.sqlite`).
 * @returns the database path.
 */
export function defaultZcodeDbPath(): string {
  return process.env.ZCODE_DB_PATH ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

/** The first-dispatch weak-check guard. */
export interface BillingGuard {
  /** Refuse (throw) when the billing provider drifted; memoize on success. */
  ensureChecked: () => void
}

/** Whether the observed provider id is one the deployment accepts. */
function isAccepted(providerId: string | undefined, expected: readonly string[]): boolean {
  return providerId !== undefined && expected.includes(providerId)
}

/**
 * Read the `provider_id` of the newest `model_usage` row.
 * @param dbPath - absolute path of the zcode billing database.
 * @returns the provider id, or `undefined` when the row lacks a usable id.
 * @throws {@link BillingSelfCheckError} when the database or its `model_usage`
 * table is missing — a silent skip would hide exactly the drift this check owns.
 */
export function latestProviderId(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) {
    throw new BillingSelfCheckError(
      `subagent-zcode: zcode billing database not found at ${dbPath}`
        + ' — run one zcode headless probe, then retry',
    )
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT provider_id FROM model_usage ORDER BY rowid DESC LIMIT 1').get()
      if (row === undefined) {
        throw new BillingSelfCheckError(
          `subagent-zcode: zcode billing database at ${dbPath} has no model_usage rows`
            + ' — run one zcode headless probe, then retry',
        )
      }
      const providerId = row['provider_id']
      return typeof providerId === 'string' ? providerId : undefined
    } finally {
      db.close()
    }
  } catch (error: unknown) {
    if (error instanceof BillingSelfCheckError) throw error
    throw new BillingSelfCheckError(
      `subagent-zcode: zcode billing database at ${dbPath} cannot be read: ${String(error)}`,
    )
  }
}

/**
 * Create the first-dispatch guard. Successes are memoized for the process; a
 * failed check stays unmemoized, so the next dispatch retries the read (the
 * database may have appeared after the user ran the probe). The expectation is
 * a set, because the CLI switches its billing provider as plan pools drain
 * (a full Start-plan day bills `account:bigmodel-start-plan`; an empty one
 * falls back to `new-provider`) — a single value would false-refuse at the
 * pool boundary.
 * @param dbPath - absolute path of the zcode billing database.
 * @param expectedProviderIds - provider ids the deployment accepts.
 * @returns the guard with its single check entry point.
 */
export function createBillingGuard(dbPath: string, expectedProviderIds: readonly string[]): BillingGuard {
  let checked = false
  return {
    ensureChecked(): void {
      if (checked) return
      const providerId = latestProviderId(dbPath)
      if (!isAccepted(providerId, expectedProviderIds)) {
        throw new BillingSelfCheckError(
          'subagent-zcode: billing self-check failed — newest model_usage row reports provider_id '
          + `${JSON.stringify(providerId)} but none of the expected providers [${expectedProviderIds.join(', ')}] matches.`
          + ' Re-pin the CLI default model with the probe closure in ZCODE-CLI-DELEGATION.md'
          + ' or extend expectedProviderIds in cordis.yml, then dispatch again.',
        )
      }
      checked = true
    },
  }
}
