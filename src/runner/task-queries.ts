import { taskActivity } from './activity.ts';
/** Queries own recovery and enrichment; HTTP and tools consume the same view. */
import { adapterForSettlement } from '../adapters/registry.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defaultEngine, type TaskEngine } from './detached.ts';
import { reconcileOrphanTask, reconcileOrphanRunningTasks } from './reconcile.ts';
import { repairTaskTranscript, projectHarvest, resolutionJsonPath } from './harvest.ts';
import { readTranscriptDocument, summarizeDocument } from './transcript-document.ts';

export function createTaskQueries(engine: TaskEngine = defaultEngine) {
  const store = engine.store;
  const { completeTask, readResolution, updateTaskMeta } = engine;
  function snapshot(id: string) {
    reconcileOrphanTask(id, engine);
    let meta = store.read(id);
    if (!meta) return null;
    // Recover a crash between recording stop intent and publishing its artifacts.
    if (meta.status !== 'RUNNING' && !existsSync(join(store.dir(id), 'completion.json'))) {
      meta = completeTask(id, { status: meta.status }) ?? meta;
    } else if (meta.status !== 'RUNNING') {
      store.appendEvent(id, 'completion', { status: meta.status });
    }
    const located = repairTaskTranscript(id, readResolution(id), { engine });
    const record = located.record;
    let adapter;
    try { adapter = engine.getAdapter(meta.adapter); } catch { adapter = adapterForSettlement(meta.adapter); }
    const document = located.transcriptPath ? readTranscriptDocument(located.transcriptPath, adapter) : null;
    const patch = {
      ...(!meta.modelId && document?.modelInfo?.modelId ? { modelId: document.modelInfo.modelId } : {}),
      ...(!meta.providerId && document?.modelInfo?.providerId ? { providerId: document.modelInfo.providerId } : {}),
      ...(!meta.sessionId && located.sessionId ? { sessionId: located.sessionId } : {}),
    };
    if (Object.keys(patch).length) meta = updateTaskMeta(id, patch) ?? meta;
    return { meta, record, document, transcriptPath: located.transcriptPath, adapter };
  }

  function getTaskDetail(id: string) {
    const task = snapshot(id);
    if (!task) return null;
    return {
      ...task.meta,
      activity: taskActivity(task.meta, store.dir(id), task.transcriptPath ?? task.record?.transcriptPath ?? null, task.adapter, engine.now()),
      report: store.readReport(id),
      rawLogTail: store.readLogTail(id),
      closingRecord: task.record,
      ...projectHarvest(task.record, task.transcriptPath, task.document),
      resolutionPath: resolutionJsonPath(id, engine),
    };
  }

  function getTaskConversation(id: string) {
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

  function getTaskTranscript(id: string) {
    const task = snapshot(id);
    return task ? { transcriptPath: task.transcriptPath, resolutionPath: resolutionJsonPath(id, engine) } : null;
  }

  function listTasks(options: { includeArchived?: boolean } = {}) {
    reconcileOrphanRunningTasks(engine);
    return store.list().filter(meta => options.includeArchived || !meta.archived).map(meta => {
      const closingRecord = readResolution(meta.taskId);
      return { ...(store.read(meta.taskId) ?? meta), closingRecord };
    }).sort((a, b) => b.startTime - a.startTime);
  }

  return {getTaskDetail, getTaskConversation, getTaskTranscript, listTasks};
}
export const {getTaskDetail, getTaskConversation, getTaskTranscript, listTasks} = createTaskQueries();
