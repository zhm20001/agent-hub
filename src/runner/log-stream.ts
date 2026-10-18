import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/** One reader per connection. Bound each read; keep partial UTF-8 bytes across polls. */
export class LogReader {
  private offset: number;
  private identity?: string;
  private prefix?: { length: number; hash: string };
  eventId = '0';
  private decoder = new StringDecoder('utf8');
  constructor(private readonly path: string, after: string | number = 0) {
    const token = /^v1:(\d+:\d+):(\d+):([a-f0-9]+):(\d+)$/.exec(String(after));
    if (token) {
      this.identity = token[1]; this.prefix = {length:Number(token[2]), hash:token[3]};
      after = Number(token[4]);
    } else after = Number(after);
    this.offset = Number.isSafeInteger(after) && after >= 0 ? Number(after) : 0;
  }
  read(final = false): { text: string; offset: number; reset: boolean; caughtUp: boolean } {
    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch (error: any) {
      if (error.code === 'ENOENT') return { text: '', offset: this.offset, reset: false, caughtUp: true };
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      const prefixHash = (length: number) => {
        const head = Buffer.alloc(Math.min(32, length));
        const count = head.length ? readSync(fd,head,0,head.length,0) : 0;
        return createHash('sha256').update(head.subarray(0,count)).digest('hex').slice(0,16);
      };
      const reset = (this.identity !== undefined && this.identity !== identity) || stat.size < this.offset
        || Boolean(this.prefix && prefixHash(this.prefix.length) !== this.prefix.hash);
      if (reset) { this.offset = 0; this.decoder = new StringDecoder('utf8'); this.prefix = undefined; }
      if (!this.prefix && stat.size) {
        const length = Math.min(32,stat.size);
        this.prefix = { length, hash:prefixHash(length) };
      }
      this.identity = identity;
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(0, stat.size - this.offset)));
      const length = buffer.length ? readSync(fd, buffer, 0, buffer.length, this.offset) : 0;
      this.offset += length;
      let text = this.decoder.write(buffer.subarray(0, length));
      const caughtUp = this.offset >= stat.size;
      if (final && caughtUp) text += this.decoder.end();
      // A reconnect must reread bytes held by StringDecoder rather than lose them.
      const pending = (this.decoder as unknown as { lastNeed: number; lastTotal: number });
      const held = pending.lastNeed ? pending.lastTotal - pending.lastNeed : 0;
      this.eventId = `v1:${identity}:${this.prefix?.length ?? 0}:${this.prefix?.hash ?? prefixHash(0)}:${this.offset-held}`;
      return { text, offset: this.offset - held, reset, caughtUp };
    } finally { closeSync(fd); }
  }
}
