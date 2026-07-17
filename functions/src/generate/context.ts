/**
 * Assembles bounded generation context: the project's current working files +
 * recent chat history, shaped into LLM messages.
 */
import { db } from '../lib/admin.js';
import type { LlmMessage } from '../llm/index.js';

const MAX_HISTORY = 16;

export interface ProjectContext {
  ownerUid: string | null;
  files: Record<string, string>;
  history: LlmMessage[];
  currentSnapshotId: string | null;
  exists: boolean;
}

export async function loadProjectContext(projectId: string): Promise<ProjectContext> {
  const projRef = db.collection('projects').doc(projectId);
  const [proj, filesSnap, msgsSnap] = await Promise.all([
    projRef.get(),
    projRef.collection('files').get(),
    projRef.collection('messages').orderBy('createdAt', 'asc').limitToLast(MAX_HISTORY).get(),
  ]);

  const files: Record<string, string> = {};
  filesSnap.forEach((d) => {
    const x = d.data() as { path: string; content: string };
    files[x.path] = x.content;
  });

  const history: LlmMessage[] = msgsSnap.docs.map((d) => {
    const m = d.data() as { role: string; content: string };
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  });

  const data = proj.data() as { ownerUid?: string; currentSnapshotId?: string } | undefined;
  return {
    ownerUid: data?.ownerUid ?? null,
    files,
    history,
    currentSnapshotId: data?.currentSnapshotId ?? null,
    exists: proj.exists,
  };
}

/** Build the messages array: history + a final turn carrying current files + the new prompt. */
export function buildMessages(
  files: Record<string, string>,
  history: LlmMessage[],
  prompt: string,
): LlmMessage[] {
  const paths = Object.keys(files);
  const filesBlock = paths.length
    ? 'Current project files:\n\n' +
      paths.map((p) => `<file path="${p}">\n${files[p]}\n</file>`).join('\n\n')
    : 'The project is currently empty (no files yet).';

  const reminder = paths.length
    ? '\n\n(These files already exist. For a small or partial change, use op="edit" with SEARCH/REPLACE ' +
      'hunks — include MULTIPLE hunks in one edit block if several spots change (e.g. renaming a word ' +
      'in a few places). Only use op="write" for a brand-new file or a near-total rewrite.)'
    : '';

  return [
    ...history,
    { role: 'user', content: `${filesBlock}\n\n---\nUser request: ${prompt}${reminder}` },
  ];
}
