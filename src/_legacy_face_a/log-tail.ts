/**
 * The observer-facing progress source: a bounded tail of the zcode CLI's own
 * day log (`~/.zcode/cli/log/YYYY-MM-DD.jsonl`), pumped into the job output
 * ring on the `log` channel. Log chunks never reach the model's `job_output`
 * render — they feed observers such as the web panel, which keeps coarse
 * progress out of the model context while staying readable from the ring.
 * @module @deepseek-ai/dsh-subagent-zcode/log-tail
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobOutputSource, JobSourceRead } from '@deepseek-ai/dsh-jobs'

/** Retained tail of the day log, in bytes; older bytes report as lossy. */
const LOG_TAIL_BYTES = 16 * 1024

/** Chunked read buffer cap per pump tick, in bytes. */
const MAX_READ_BYTES = 64 * 1024

/**
 * The zcode CLI day-log directory. `ZCODE_LOG_DIR` overrides it for relocated
 * zcode homes and for tests; the default is the CLI's own storage contract.
 * @returns the log directory path.
 */
export function defaultZcodeLogDir(): string {
  return process.env.ZCODE_LOG_DIR ?? join(homedir(), '.zcode', 'cli', 'log')
}

/** Local-calendar `YYYY-MM-DD` of one epoch timestamp. */
function dayFile(timestamp: number): string {
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return join(`${date.getFullYear()}-${month}-${day}.jsonl`)
}

/**
 * Build a pull source streaming the day log's tail into the job ring. The
 * log file is bound at job start (the local date of `startedAt`); a missing
 * or empty file reads as empty — the plain no-logs-yet state, never an error.
 * @param dir - the zcode log directory.
 * @param startedAt - epoch ms the job started (binds the day file).
 * @returns one `log`-channel source over the day log's retained tail.
 */
export function zcodeLogTailSource(dir: string, startedAt: number): JobOutputSource {
  const file = join(dir, dayFile(startedAt))
  return {
    channel: 'log',
    read: (fromByte): JobSourceRead => {
      if (!existsSync(file)) return { text: '', nextOffset: fromByte, lossy: false }
      const size = statSync(file).size
      if (size === 0) return { text: '', nextOffset: fromByte, lossy: false }
      const retained = Math.max(fromByte, Math.min(size - LOG_TAIL_BYTES, size))
      const lossy = retained > fromByte
      const end = Math.min(size, retained + MAX_READ_BYTES)
      if (end <= retained) return { text: '', nextOffset: size, lossy }
      // Bounded sequential slice of an append-only file: open/read/close per
      // pump tick keeps the source stateless across registry-driven reads.
      const text = readSlice(file, retained, end)
      return { text, nextOffset: Math.min(size, end), lossy }
    },
  }
}

/** Read one bounded byte slice of a file as UTF-8 text. */
function readSlice(file: string, start: number, end: number): string {
  const handle = openSync(file, 'r')
  try {
    const length = end - start
    const buffer = Buffer.alloc(length)
    const read = readSync(handle, buffer, 0, length, start)
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(handle)
  }
}
