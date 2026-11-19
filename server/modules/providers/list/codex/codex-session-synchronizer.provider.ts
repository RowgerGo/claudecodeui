import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildCloudCliSessionName,
  buildLookupMap,
  extractCodexTextContent,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  parseFilesInputTag,
  readFileTimestamps,
  readObjectRecord,
} from '@/shared/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/index.js';

const UNTITLED = 'Untitled Codex Session';

async function readLegacyOpeningName(filePath: string): Promise<string | undefined> {
  const first = await extractFirstValidJsonlData(filePath, (entry) => {
    const row = readObjectRecord(entry);
    const payload = readObjectRecord(row?.payload);
    if (row?.type !== 'event_msg' || !payload) return null;
    if (payload.type === 'user_message' && (!payload.kind || payload.kind === 'plain') && typeof payload.message === 'string') {
      return { text: payload.message };
    }
    const item = readObjectRecord(payload.item);
    if (payload.type === 'item_completed' && item?.type === 'UserMessage') {
      return { text: extractCodexTextContent(item.content) };
    }
    return null;
  });
  const text = first && parseFilesInputTag(first.text).text;
  return text?.trim() ? buildCloudCliSessionName(text) : undefined;
}

/** The providers module indexes Codex rollouts and reconciles thread names from their separate index. */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  readonly nameIndexPath = path.join(this.codexHome, 'session_index.jsonl');
  private nameIndex?: { revision: string; names: Promise<Map<string, string>> };
  private legacyOpeningNames = new Map<string, string>();
  private pendingNames: Promise<unknown> = Promise.resolve();

  async synchronize(since?: Date): Promise<number> {
    const names = await this.readNameIndex();
    const files = await findFilesRecursivelyCreatedAfter(path.join(this.codexHome, 'sessions'), '.jsonl', since ?? null);
    let processed = 0;
    for (const filePath of files) {
      if (await this.upsertRollout(filePath, names)) processed += 1;
    }

    // A title can appear long after its rollout's birthtime. A refresh that
    // sees the change before the watcher must announce it to other clients too.
    const changed = await this.synchronizeNames();
    if (changed.length) {
      const { broadcastSessionUpsertedBatch } = await import('@/modules/websocket/index.js');
      await broadcastSessionUpsertedBatch(changed, { titleOnly: true });
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl') || filePath === this.nameIndexPath) return null;
    const parsed = await this.upsertRollout(filePath, await this.readNameIndex());
    if (!parsed) return null;
    await this.synchronizeNames(parsed.providerSessionId);
    return parsed.appSessionId;
  }

  /** The sessions watcher uses this for title-only index writes, including multiple renames in one poll. */
  synchronizeNames(providerSessionId?: string): Promise<string[]> {
    // Legacy verification reads a rollout asynchronously. Serialize index writes
    // so an older snapshot cannot overwrite a newer rename after that read.
    const updated = this.pendingNames.then(async () => {
      const names = await this.readNameIndex();
      const changed: string[] = [];
      const threadIds = providerSessionId ? [providerSessionId] : names.keys();
      for (const threadId of threadIds) {
        const name = names.get(threadId);
        if (!name) continue;
        const session = sessionsDb.getSessionByProviderSessionId(threadId);
        if (!session || session.provider !== this.provider || session.name_source === 'manual') continue;
        const title = normalizeSessionName(name, UNTITLED);
        if (session.name_source === 'provider' && session.custom_name === title) continue;
        const legacyFallback = session.name_source === 'legacy' && session.session_id !== threadId && session.jsonl_path
          ? await this.getLegacyOpeningName(session.jsonl_path)
          : undefined;
        const appId = sessionsDb.applyCodexThreadName(threadId, title, legacyFallback);
        if (appId) changed.push(appId);
      }
      return changed;
    });
    this.pendingNames = updated.catch(() => {});
    return updated;
  }

  private async getLegacyOpeningName(filePath: string): Promise<string | undefined> {
    // A rollout's opening prompt is immutable. When a file has no prompt yet,
    // leave it uncached so its next write can supply the evidence.
    const cached = this.legacyOpeningNames.get(filePath);
    if (cached !== undefined) return cached;
    const opening = await readLegacyOpeningName(filePath);
    if (opening !== undefined) this.legacyOpeningNames.set(filePath, opening);
    return opening;
  }

  private async readNameIndex(): Promise<Map<string, string>> {
    let info;
    try {
      info = await stat(this.nameIndexPath);
    } catch {
      this.nameIndex = undefined;
      return new Map();
    }
    const revision = [info.ino, info.size, info.ctimeMs, info.mtimeMs].join('/');
    if (revision !== this.nameIndex?.revision) {
      this.nameIndex = {
        revision,
        names: buildLookupMap(this.nameIndexPath, 'id', 'thread_name', 'last-nonblank'),
      };
    }
    return this.nameIndex.names;
  }

  private async upsertRollout(filePath: string, names: Map<string, string>) {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = readObjectRecord(rawData);
      const payload = readObjectRecord(data?.payload);
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    let fallback = existingSession?.custom_name;
    if ((!fallback || fallback === UNTITLED) && !names.has(parsed.sessionId)) {
      fallback = normalizeSessionName(await this.extractLastAgentMessageFromEnd(filePath), UNTITLED);
    }
    const timestamps = await readFileTimestamps(filePath);
    const appSessionId = sessionsDb.createSession(
      parsed.sessionId, this.provider, parsed.projectPath, fallback || UNTITLED,
      timestamps.createdAt, timestamps.updatedAt, filePath,
    );
    return { appSessionId, providerSessionId: parsed.sessionId };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}

/** Shared by the provider registry and the session watcher so index reads and writes stay ordered. */
export const codexSessionSynchronizer = new CodexSessionSynchronizer();
