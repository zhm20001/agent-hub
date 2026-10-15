/** Queries own recovery and enrichment; HTTP and tools consume the same view. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTaskStore } from './task-store.ts';
import { completeTask, readResolution, updateTaskMeta } from './detached.ts';
import { reconcileOrphanTask, reconcileOrphanRunningTasks } from './reconcile.ts';
import { repairTaskTranscript, projectHarvest, resolutionJsonPath } from './harvest.ts';
import { readTranscriptDocument, summarizeDocument } from './transcript-document.ts';

function snapshot(id: string) {
  reconcileOrphanTask(id);
  let meta = defaultTaskStore.read(id);
  if (!meta) return null;
  // Recover a crash between recording stop intent and publishing its artifacts.
  if (meta.status !== 'RUNNING' && !existsSync(join(defaultTaskStore.dir(id), 'completion.json'))) {
    meta = completeTask(id, { status: meta.status }) ?? meta;
  }
  const located = repairTaskTranscript(id, readResolution(id));
  const record = located.record;
  const document = located.transcriptPath ? readTranscriptDocument(located.transcriptPath, meta.adapter) : null;
  const patch = {
    ...(!meta.modelId && document?.modelInfo?.modelId ? { modelId: document.modelInfo.modelId } : {}),
    ...(!meta.providerId && document?.modelInfo?.providerId ? { providerId: document.modelInfo.providerId } : {}),
    ...(!meta.sessionId && located.sessionId ? { sessionId: located.sessionId } : {}),
  };
  if (Object.keys(patch).length) meta = updateTaskMeta(id, patch) ?? meta;
  return { meta, record, document, transcriptPath: located.transcriptPath };
}

export function getTaskDetail(id: string) {
  const task = snapshot(id);
  if (!task) return null;
  return {
    ...task.meta,
    report: defaultTaskStore.readReport(id),
    rawLogTail: defaultTaskStore.readLogTail(id),
    closingRecord: task.record,
    ...projectHarvest(task.record, task.transcriptPath, task.document),
    resolutionPath: resolutionJsonPath(id),
  };
}

export function getTaskConversation(id: string) {
  const task = snapshot(id);
  if (!task) return null;
  const turns = task.document ? summarizeDocument(task.document) : [];
  return {
    turns,
    transcriptPath: task.transcriptPath,
    emptyReason: turns.length ? null : task.transcriptPath ? 'empty-transcript'
      : task.meta.status === 'TIMEOUT_KILLED' ? 'timeout-no-transcript' : 'no-transcript',
    sessionId: task.record?.resolution.sessionRef?.handle ?? task.meta.sessionId ?? null,
  };
}

export function getTaskTranscript(id: string) {
  const task = snapshot(id);
  return task ? { transcriptPath: task.transcriptPath, resolutionPath: resolutionJsonPath(id) } : null;
}

export function listTasks(options: { includeArchived?: boolean } = {}) {
  reconcileOrphanRunningTasks();
  return defaultTaskStore.list().filter(meta => options.includeArchived || !meta.archived).map(meta => {
    const closingRecord = readResolution(meta.taskId);
    return { ...(defaultTaskStore.read(meta.taskId) ?? meta), closingRecord };
  }).sort((a, b) => b.startTime - a.startTime);
}
