/** Legacy raw-text helper. New callers should summarize an already parsed document. */
import { parseKnownTranscript } from '../adapters/transcript-format.ts';
import { summarizeDocument, type SummarizeOptions, type ConversationTurn } from './transcript.ts';
export function summarizeTranscript(raw: string, options: SummarizeOptions = {}): ConversationTurn[] {
  return summarizeDocument(parseKnownTranscript(raw), options);
}
