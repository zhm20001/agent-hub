import { join, dirname } from 'node:path';
import type { Project } from './projects.ts';
import type { TaskStore } from './runner/task-store.ts';
import { artifactState, captureArtifact, type ArtifactReference } from './runner/evidence.ts';

export interface CheckpointInput {
  expectedSequence: number;
  author: string;
  summary: string;
  nextStep: string;
  revision?: string;
  pullRequest?: string;
  decision?: 'pending' | 'accepted' | 'rejected';
  sourceTaskIds?: string[];
  checks?: Array<{ name: string; status: 'passed' | 'failed' | 'not-run'; required: boolean }>;
  artifacts?: Array<{ path: string; retain?: boolean }>;
}
export interface ProjectCheckpoint extends Omit<CheckpointInput, 'expectedSequence' | 'artifacts'> {
  sequence: number;
  createdAt: number;
  source: 'caller';
  artifacts: ArtifactReference[];
}
export class CheckpointError extends Error {
  readonly name = 'CheckpointError';
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
function text(value: unknown, field: string, max = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CheckpointError(`Invalid checkpoint ${field}`);
  return value.trim();
}
/** Caller-authored acceptance/current-state records; never inferred from task completion. */
export class ProjectCheckpoints {
  constructor(private readonly store: TaskStore, private readonly project: (id: string) => Project | null) {}
  private database() {
    const db = this.store.database;
    db.exec('CREATE TABLE IF NOT EXISTS hub_project_checkpoints (project_id TEXT NOT NULL, sequence INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    return db;
  }
  latest(projectId: string) {
    if (!this.project(projectId)) throw new CheckpointError('Project not found', 404);
    const row = this.database().prepare('SELECT body FROM hub_project_checkpoints WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(projectId);
    if (!row) return null;
    const record = JSON.parse(String(row.body)) as ProjectCheckpoint;
    return { ...record, artifacts: record.artifacts.map(artifact => ({ ...artifact, sourceState: artifactState(artifact.path, artifact.sha256), retainedState: artifactState(artifact.retainedPath, artifact.sha256) })) };
  }
  append(projectId: string, input: CheckpointInput): ProjectCheckpoint {
    const project = this.project(projectId); if (!project) throw new CheckpointError('Project not found', 404);
    if (!input || !Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0) throw new CheckpointError('Invalid expectedSequence');
    const author = text(input.author, 'author', 200), summary = text(input.summary, 'summary'), nextStep = text(input.nextStep, 'nextStep');
    const revision = input.revision === undefined ? undefined : text(input.revision, 'revision', 200);
    const pullRequest = input.pullRequest === undefined ? undefined : text(input.pullRequest, 'pullRequest', 2000);
    if (pullRequest && !/^https?:\/\//.test(pullRequest)) throw new CheckpointError('Invalid pullRequest URL');
    if (input.decision !== undefined && !['pending', 'accepted', 'rejected'].includes(input.decision)) throw new CheckpointError('Invalid decision');
    if (input.decision === 'accepted' && !revision) throw new CheckpointError('An accepted declaration requires a revision');
    if (input.sourceTaskIds !== undefined && (!Array.isArray(input.sourceTaskIds) || input.sourceTaskIds.length > 100 || input.sourceTaskIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)))) throw new CheckpointError('Invalid sourceTaskIds');
    const sourceTaskIds = [...new Set(input.sourceTaskIds ?? [])];
    for (const id of sourceTaskIds) if (this.store.read(id)?.projectId !== projectId) throw new CheckpointError(`Source task missing or belongs to another project: ${id}`);
    if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length > 100)) throw new CheckpointError('Invalid checks');
    const checks = (input.checks ?? []).map(check => {
      if (!check || !['passed', 'failed', 'not-run'].includes(check.status)) throw new CheckpointError('Invalid check status');
      if (typeof check.required !== 'boolean') throw new CheckpointError('Invalid check required');
      return { name: text(check.name, 'check name', 200), status: check.status, required: check.required };
    });
    if (input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.length > 20)) throw new CheckpointError('At most 20 artifacts are allowed');
    this.store.list(); const db = this.database(); db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT sequence FROM hub_project_checkpoints WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(projectId);
      if (Number(previous?.sequence ?? 0) !== input.expectedSequence) throw new CheckpointError('Checkpoint sequence conflict: reread current state before updating', 409);
      const artifacts = (input.artifacts ?? []).map(input => {
        try { return captureArtifact(input, [project.cwd ?? dirname(this.store.runsDir), this.store.runsDir], join(this.store.runsDir, 'project-evidence', projectId)); }
        catch (error) { throw new CheckpointError((error as Error).message); }
      });
      const record = { author, summary, nextStep, revision, pullRequest, decision: input.decision ?? 'pending', checks, sourceTaskIds, artifacts, createdAt: Date.now(), source: 'caller' as const };
      const sequence = Number(db.prepare("INSERT INTO hub_project_events(project_id,kind,object_id,body) VALUES (?,'checkpoint',?,?)").run(projectId, projectId, JSON.stringify(record)).lastInsertRowid);
      const checkpoint = { ...record, sequence };
      db.prepare('INSERT INTO hub_project_checkpoints(project_id,sequence,body) VALUES (?,?,?)').run(projectId, sequence, JSON.stringify(checkpoint));
      db.exec('COMMIT'); return checkpoint;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
