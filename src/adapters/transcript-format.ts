/** Agent wire formats live here; callers consume only TranscriptDocument. */
import type { TranscriptDocument, TranscriptMessage, ModelInfo } from '../shared/transcript.ts';
type Obj = Record<string, any>;
function objects(input: unknown): Obj[] {
  if (typeof input === 'string') {
    try { return objects(JSON.parse(input)); } catch {
      return input.split('\n').flatMap(line => { try { return objects(JSON.parse(line)); } catch { return []; } });
    }
  }
  if (Array.isArray(input)) return input.flatMap(objects);
  return input && typeof input === 'object' ? [input as Obj] : [];
}
function contentText(content: unknown, separator = '\n'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => {
    if (typeof part === 'string') return [part];
    if (part && typeof part === 'object' && !['reasoning', 'thinking', 'tool_call', 'tool_result'].includes(part.type)
        && typeof part.text === 'string') return [part.text];
    return [];
  }).join(separator);
}
function add(messages: TranscriptMessage[], role: unknown, text: unknown): void {
  if (role === 'agent') role = 'assistant';
  if ((role !== 'assistant' && role !== 'user') || typeof text !== 'string' || !text.trim()) return;
  if (role === 'user' && (text.trim().startsWith('<system-reminder>') || text.trim().startsWith('[SYSTEM NOTIFICATION'))) return;
  messages.push({ role, text: text.replace(/\r\n/g, '\n').trimEnd() });
}
function addMessage(messages: TranscriptMessage[], object: Obj): void {
  if (!object || typeof object !== 'object') return;
  add(messages, object.role ?? object.info?.role,
    contentText(object.parts, '\n\n') || contentText(object.content) || object.text);
}
function freeze(messages: TranscriptMessage[], modelInfo: ModelInfo | null): TranscriptDocument {
  return Object.freeze({ messages: Object.freeze(messages.map(message => Object.freeze(message))),
    modelInfo: modelInfo ? Object.freeze(modelInfo) : null });
}
/** Neutral message arrays are readable regardless of the producing Agent. */
export function parseMessageDocument(input: unknown): TranscriptDocument {
  const messages: TranscriptMessage[] = [];
  for (const object of objects(input)) {
    if (Array.isArray(object.messages)) object.messages.forEach((message: Obj) => addMessage(messages, message));
    else addMessage(messages, object);
  }
  return freeze(messages, null);
}
export function parseZcodeTranscript(input: unknown): TranscriptDocument {
  const entries = objects(input);
  const messages: TranscriptMessage[] = [];
  let modelInfo: ModelInfo | null = null;
  const hasTurnComplete = entries.some(e => e.type === 'turn_complete' && typeof e.payload?.response === 'string' && e.payload.response.trim());
  const hasModelComplete = entries.some(e => e.type === 'model_complete' && e.payload?.stopReason !== 'tool-calls' && typeof e.payload?.content === 'string' && e.payload.content.trim());
  let emittedRequest = false;
  for (const object of entries) {
    const model = object.model && typeof object.model === 'object' ? object.model : object;
    const info = { ...(typeof model.modelId === 'string' && model.modelId ? { modelId: model.modelId } : {}),
      ...(typeof model.providerId === 'string' && model.providerId ? { providerId: model.providerId } : {}) };
    if (Object.keys(info).length) modelInfo = { ...modelInfo, ...info };
    if (Array.isArray(object.messages)) { object.messages.forEach((message: Obj) => addMessage(messages, message)); continue; }
    if (object.role || object.info?.role) { addMessage(messages, object); continue; }
    if (object.type === 'turn_started') { add(messages, 'user', object.payload?.input); continue; }
    if (!emittedRequest && Array.isArray(object.request?.messages)) {
      for (const message of object.request.messages) {
        const before = messages.length;
        if (message?.role === 'user') addMessage(messages, message);
        if (messages.length > before) { emittedRequest = true; break; }
      }
    }
    if (hasTurnComplete) {
      if (object.type === 'turn_complete') add(messages, 'assistant', object.payload?.response);
    } else if (hasModelComplete) {
      if (object.type === 'model_complete' && object.payload?.stopReason !== 'tool-calls') add(messages, 'assistant', object.payload?.content);
    } else { add(messages, 'assistant', typeof object.response === 'string' ? object.response : object.response?.text); }
  }
  return freeze(messages, modelInfo);
}
export function parseCodexTranscript(input: unknown): TranscriptDocument {
  const entries = objects(input);
  const messages: TranscriptMessage[] = [];
  let modelInfo: ModelInfo | null = null;
  const hasResponseItems = entries.some(e => e.type === 'response_item' && e.payload?.type === 'message');
  for (const object of entries) {
    if (Array.isArray(object.messages)) { object.messages.forEach((message: Obj) => addMessage(messages, message)); continue; }
    if (object.role || object.info?.role) { addMessage(messages, object); continue; }
    const payload = object.payload;
    if (object.type === 'session_meta' || object.type === 'turn_context') {
      const info = { ...(typeof payload?.model === 'string' ? { modelId: payload.model } : {}),
        ...(typeof payload?.model_provider === 'string' ? { providerId: payload.model_provider } : {}) };
      if (Object.keys(info).length) modelInfo = { ...modelInfo, ...info };
    }
    if (object.type === 'response_item' && payload?.type === 'message') addMessage(messages, payload);
    if (object.type === 'item.completed' && object.item?.type === 'agent_message') add(messages, 'assistant', object.item.text);
    if (!hasResponseItems && object.type === 'event_msg') {
      if (payload?.type === 'user_message') add(messages, 'user', payload.message);
      if (payload?.type === 'agent_message') add(messages, 'assistant', payload.message);
    }
  }
  return freeze(messages, modelInfo);
}
/** Compatibility entry point for older helpers that did not carry provenance. */
export function parseKnownTranscript(input: unknown): TranscriptDocument {
  return objects(input).some(e => ['response_item', 'event_msg', 'item.completed', 'session_meta'].includes(e.type))
    ? parseCodexTranscript(input) : parseZcodeTranscript(input);
}
export function modelInfoFromOutput(output: string): ModelInfo | null {
  const model = output.match(/"modelId"\s*:\s*"([^"]+)"/);
  const provider = output.match(/"providerId"\s*:\s*"([^"]+)"/);
  return model || provider ? { ...(model ? { modelId: model[1] } : {}), ...(provider ? { providerId: provider[1] } : {}) } : null;
}
