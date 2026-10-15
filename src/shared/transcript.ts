/** Agent-neutral data shared by transcript readers and board projections. */
export interface TranscriptMessage { readonly role: 'user' | 'assistant'; readonly text: string }
export interface ModelInfo { readonly modelId?: string; readonly providerId?: string }
export interface TranscriptDocument { readonly messages: readonly TranscriptMessage[]; readonly modelInfo: ModelInfo | null }
export type ConversationRole = 'user' | 'assistant' | 'other';
export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly text: string;
  readonly truncated: boolean;
  readonly fullText: string;
}
export interface SummarizeOptions { readonly maxChars?: number; readonly maxTurns?: number }
export function lastAssistantText(document: TranscriptDocument): string | null {
  return document.messages.findLast(message => message.role === 'assistant')?.text ?? null;
}
export function summarizeDocument(document: TranscriptDocument, options: SummarizeOptions = {}): ConversationTurn[] {
  const cap = Math.max(1, options.maxChars ?? 400);
  const count = Math.max(0, options.maxTurns ?? 80);
  return (count === 0 ? [] : document.messages.slice(-count)).map(message => {
    const text = message.text.replace(/\s+/g, ' ').trim();
    return { role: message.role, text: text.length > cap ? `${text.slice(0, cap - 1)}…` : text,
      truncated: text.length > cap, fullText: message.text };
  });
}
