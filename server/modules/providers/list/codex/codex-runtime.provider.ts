import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
} from '@/shared/index.js';
import { parseFilesInputTag, toImageAttachments } from '@/shared/image-attachments.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type {
  AnyRecord,
  ChatCodexOperation,
  CodexControlHooks,
  CodexControlResult,
  CodexGoal,
  CompactionInfo,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SideQuestionOutcome,
  SideQuestionRequest,
  SideQuestionSink,
} from '@/shared/types.js';

import { codexAppServer } from './codex-app-server.client.js';

type ChatConnection = Parameters<Parameters<typeof codexAppServer.withChatConnection>[0]>[0];

type Turn = {
  id: string;
  writer: ProviderRuntimeWriter;
  cwd: string;
  stopped: boolean;
  surfacedError: boolean;
  done: ReturnType<typeof deferred<void>>;
  textByItem: Map<string, string>;
  commands: Map<string, AnyRecord>;
  deliveredMessages: Set<string>;
  compactions: Map<string, { item: AnyRecord; completed: boolean }>;
  pendingProgress: Map<string, AnyRecord>;
  progressTimer?: NodeJS.Timeout;
  deferredTerminal?: AnyRecord;
  terminalTimer?: NodeJS.Timeout;
  compactionError?: Error;
};

type PendingTurn = {
  writer: ProviderRuntimeWriter;
  cwd: string;
  stopped: boolean;
  sent: boolean;
  done: ReturnType<typeof deferred<void>>;
  turn?: Turn;
};

type PendingCompaction = {
  done: ReturnType<typeof deferred<CodexControlResult>>;
  sent: boolean;
  turnId?: string;
};

type ThreadOptions = {
  cwd: string;
  model?: string;
  config?: AnyRecord;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: string | AnyRecord;
};

const sessions = new Map<string, CodexThreadConnection>();
const INTERRUPT_GRACE_MS = 5_000;
const COMPACTION_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 100;
const CODEX_IMAGE_ONLY_PROMPT = 'Please analyze the attached image(s).';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function buildTurnInput(command: string, options: AnyRecord, cwd: string) {
  const prompt = appendFilesInputTag(command, options.files);
  const images = normalizeImageDescriptors(options.images);
  const text = !prompt.trim() && images.length > 0 ? CODEX_IMAGE_ONLY_PROMPT : prompt;
  return buildCodexInputItems(text, images, cwd).map((item) =>
    item.type === 'local_image' ? { type: 'localImage', path: item.path } : item,
  );
}

function mapPermissionMode(permissionMode: unknown): Pick<ThreadOptions, 'sandbox' | 'approvalPolicy'> {
  return {
    sandbox: permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
  };
}

function normalizeItem(item: AnyRecord): AnyRecord | null {
  const base = { type: 'item', itemId: item.id };
  const status = item.status === 'inProgress' ? 'in_progress' : item.status;
  switch (item.type) {
    case 'agentMessage': {
      const entries = item.memoryCitation?.entries;
      const memoryCitations = Array.isArray(entries)
        ? entries.map((entry: AnyRecord) => ({
          source: `${entry.path}:${entry.lineStart}-${entry.lineEnd}`,
          ...(entry.note ? { note: entry.note } : {}),
        }))
        : undefined;
      return { ...base, itemType: 'agent_message', message: { content: item.text }, memoryCitations };
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.join('\n') : '';
      return summary ? { ...base, itemType: 'reasoning', message: { content: summary } } : null;
    }
    case 'commandExecution':
      return {
        ...base,
        itemType: 'command_execution',
        status,
        command: item.command,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
      };
    case 'fileChange':
      return {
        ...base,
        itemType: 'file_change',
        status,
        changes: Array.isArray(item.changes)
          ? item.changes.map((change: AnyRecord) => ({ ...change, kind: change.kind?.type }))
          : [],
      };
    case 'mcpToolCall':
      return {
        ...base,
        itemType: 'mcp_tool_call',
        status,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      };
    case 'webSearch':
      return { ...base, itemType: 'web_search', query: item.query };
    case 'plan':
      return item.text ? {
        ...base,
        itemType: 'agent_message',
        message: { content: `<proposed_plan>\n${item.text}\n</proposed_plan>` },
      } : null;
    case 'userMessage':
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'subAgentActivity':
      return null;
    default:
      return { ...base, itemType: item.type, item };
  }
}

function readTokenBudget(usage: AnyRecord) {
  const inputTokens = Number(usage.total?.inputTokens) || 0;
  const outputTokens = Number(usage.total?.outputTokens) || 0;
  return {
    used: Number(usage.total?.totalTokens) || inputTokens + outputTokens,
    total: Number(usage.modelContextWindow) || 200_000,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function normalizeSteerEcho(item: AnyRecord, sessionId: string) {
  const content: AnyRecord[] = Array.isArray(item.content) ? item.content : [];
  const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const parsed = parseFilesInputTag(text);
  const imagePaths = content
    .filter((part) => part.type === 'localImage' && typeof part.path === 'string')
    .map((part) => part.path as string);
  return createNormalizedMessage({
    kind: 'text',
    id: item.clientId,
    role: 'user',
    content: parsed.text,
    files: parsed.attachments,
    images: toImageAttachments(imagePaths),
    sessionId,
    provider: 'codex',
  });
}

function controlRejected(code: string, goal?: CodexGoal | null): CodexControlResult {
  return { status: 'rejected', code, ...(goal !== undefined ? { goal } : {}) };
}

function controlFailed(error: unknown, goal?: CodexGoal | null): CodexControlResult {
  return {
    status: 'failed',
    code: 'CODEX_NATIVE_ERROR',
    error: error instanceof Error ? error.message : String(error),
    ...(goal !== undefined ? { goal } : {}),
  };
}

function readGoal(value: unknown, threadId: string): CodexGoal | null {
  if (value === null) return null;
  const goal = readObjectRecord(value);
  if (goal?.threadId !== threadId || typeof goal.objective !== 'string'
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)
    || typeof goal.tokensUsed !== 'number' || typeof goal.createdAt !== 'number'
    || typeof goal.updatedAt !== 'number' || typeof goal.timeUsedSeconds !== 'number'
    || (goal.tokenBudget !== null && typeof goal.tokenBudget !== 'number')) {
    throw new Error('Codex returned an invalid thread goal.');
  }
  return goal as CodexGoal;
}

function busyError(): AppError {
  return new AppError('Codex already has a turn or session operation in progress.', {
    code: 'CODEX_TURN_BUSY',
    statusCode: 409,
  });
}

async function resolveThreadOptions(
  options: AnyRecord,
  context: ProviderRuntimeContext,
  inheritPermissions = false,
): Promise<ThreadOptions> {
  const { sessionId, cwd, projectPath, model, effort, permissionMode } = options;
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const catalog = await context.getProviderModels();
  const modelInfo = catalog.OPTIONS.find((option) => option.value === resolvedModel);
  const resolvedEffort = effort !== 'default' && modelInfo?.effort?.values?.some((value) => value.value === effort)
    ? effort
    : undefined;
  return {
    cwd: cwd || projectPath || process.cwd(),
    model: resolvedModel,
    ...(inheritPermissions && permissionMode === undefined ? {} : mapPermissionMode(permissionMode)),
    config: resolvedEffort ? { model_reasoning_effort: resolvedEffort } : undefined,
  };
}

async function readRolloutPermissions(filePath: string): Promise<Partial<ThreadOptions>> {
  let lastContext: AnyRecord | null = null;
  const stream = createReadStream(filePath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"turn_context"')) continue;
      try {
        const entry = readObjectRecord(JSON.parse(line));
        if (entry?.type === 'turn_context') lastContext = readObjectRecord(entry.payload);
      } catch {
        // The CLI can be appending the next row while a reader opens the file.
      }
    }
  } catch {
    // An archived or legacy rollout may have moved since thread/read.
    return {};
  } finally {
    lines.close();
    stream.destroy();
  }

  const options: Partial<ThreadOptions> = {};
  const sandbox = lastContext?.sandbox_policy;
  const mode = typeof sandbox === 'string' ? sandbox : sandbox?.type;
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') options.sandbox = mode;

  const approval = lastContext?.approval_policy;
  const granular = readObjectRecord(approval?.granular);
  if (approval === 'untrusted' || approval === 'on-request' || approval === 'never') {
    options.approvalPolicy = approval;
  } else if (granular && ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations']
    .every((key) => typeof granular[key] === 'boolean')) {
    options.approvalPolicy = { granular };
  }
  if (mode === 'workspace-write' && typeof sandbox === 'object' && sandbox !== null) {
    const workspace: AnyRecord = {};
    if (Array.isArray(sandbox.writable_roots) && sandbox.writable_roots.every((root: unknown) => typeof root === 'string')) {
      workspace.writable_roots = sandbox.writable_roots;
    }
    for (const key of ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp']) {
      if (typeof sandbox[key] === 'boolean') workspace[key] = sandbox[key];
    }
    if (Object.keys(workspace).length > 0) options.config = { sandbox_workspace_write: workspace };
  }
  return options;
}

/**
 * A connection owns one native thread and may outlive many turns. Each turn
 * has its own writer, buffers and lifecycle; session controls hold admission
 * independently so a failed RPC cannot complete an unrelated turn.
 */
class CodexThreadConnection {
  private readonly controller = new AbortController();
  private readonly connected = deferred<ChatConnection>();
  private readonly lifetime = deferred<void>();
  private threadOptions?: ThreadOptions;
  private opening?: Promise<void>;
  private threadOpened = false;
  private earlyEvents: [string, AnyRecord][] = [];
  private activeTurn?: Turn;
  private pendingTurn?: PendingTurn;
  private compaction?: PendingCompaction;
  private goal: CodexGoal | null = null;
  private goalVersion = 0;
  private goalReaders = 0;
  private nativeThreadActive = false;
  private readonly settledTurns = new Set<string>();
  private closed = false;
  private threadId: string | null;
  private workingDirectory = process.cwd();
  private sessionSummary?: string;

  constructor(
    private readonly appSessionId: string | undefined,
    private readonly context: ProviderRuntimeContext,
    private hooks?: CodexControlHooks,
  ) {
    this.threadId = context.resolveProviderSessionId(appSessionId);
    void this.connected.promise.catch(() => {});
    void codexAppServer.withChatConnection(async (connection) => {
      connection.onNotification((method, params) => this.receive(method, params));
      connection.onExit((reason) => this.onExit(new Error(reason)));
      this.connected.resolve(connection);
      await this.lifetime.promise;
    }, this.controller.signal).then(
      () => this.onExit(new Error('Codex app-server connection closed.')),
      (error: unknown) => this.onExit(error),
    );
  }

  setHooks(hooks?: CodexControlHooks) {
    if (hooks) this.hooks = hooks;
  }

  releaseReadConnectionIfRepointed(threadId: string | null) {
    if (this.threadId === threadId || this.threadOpened || this.changingThread()) return false;
    // An edit can fork/repoint the app session while a metadata-only read is
    // in flight. Open the newly mapped thread instead of reusing that reader.
    this.close();
    return true;
  }

  blocksUserTurn() {
    return this.changingThread() || this.hasGoalTurn();
  }

  private changingThread() {
    return Boolean(this.activeTurn || this.pendingTurn || this.compaction);
  }

  private hasGoalTurn() {
    return this.nativeThreadActive || (this.threadOpened && this.goal?.status === 'active');
  }

  private async openThread(options: ThreadOptions, bindThread: (id: string, created: boolean) => void) {
    if (this.threadOpened) return;
    this.opening ??= (async () => {
      const resumedId = this.threadId;
      const connection = await this.connected.promise;
      const opened = readObjectRecord(resumedId
        ? await connection.call('thread/resume', { ...options, threadId: resumedId, excludeTurns: true })
        : await connection.call('thread/start', { ...options, ephemeral: false }));
      const nativeId = opened?.thread?.id;
      if (typeof nativeId !== 'string' || (resumedId && nativeId !== resumedId)) {
        throw new Error('Codex did not open the requested thread.');
      }
      this.threadId = nativeId;
      this.threadOpened = true;
      this.threadOptions = options;
      this.workingDirectory = options.cwd;
      if (!this.appSessionId && !sessions.has(nativeId)) sessions.set(nativeId, this);
      // Persist the mapping before delivering events, particularly for a
      // goal-first conversation whose first model turn is provider-initiated.
      bindThread(nativeId, !resumedId);
      for (const [method, params] of this.earlyEvents.splice(0)) this.receive(method, params);
    })();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async openThreadForControl(options: AnyRecord, hooks: CodexControlHooks) {
    if (this.threadOpened) return;
    const threadId = this.threadId;
    const resolved = await resolveThreadOptions(options, this.context, Boolean(threadId));
    if (threadId) {
      const connection = await this.connected.promise;
      const response = readObjectRecord(await connection.call('thread/read', { threadId, includeTurns: false }));
      const thread = readObjectRecord(response?.thread);
      if (thread?.id === threadId) {
        if (typeof thread.cwd === 'string') resolved.cwd = thread.cwd;
        if (typeof thread.model === 'string') resolved.model = thread.model;
        if (typeof thread.reasoningEffort === 'string') {
          resolved.config = { ...resolved.config, model_reasoning_effort: thread.reasoningEffort };
        }
        if (options.permissionMode === undefined && typeof thread.path === 'string') {
          // 0.170 may pick a new default sandbox during resume. Recover the
          // last executed policy from the provider-owned rollout.
          const permissions = await readRolloutPermissions(thread.path);
          resolved.sandbox = permissions.sandbox;
          resolved.approvalPolicy = permissions.approvalPolicy;
          if (permissions.config) resolved.config = { ...resolved.config, ...permissions.config };
        }
      }
    }
    await this.openThread(resolved, hooks.bindThread);
  }

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter): Promise<void> {
    if (this.blocksUserTurn()) throw busyError();
    const pending: PendingTurn = {
      writer, cwd: options.cwd || options.projectPath || process.cwd(),
      stopped: false, sent: false, done: deferred<void>(),
    };
    this.pendingTurn = pending;
    this.sessionSummary = options.sessionSummary ?? this.sessionSummary;
    try {
      const threadOptions = await resolveThreadOptions(options, this.context);
      if (pending.stopped) {
        await this.finishPending(pending);
        return;
      }
      const alreadyOpen = this.threadOpened;
      // A read-only lookup prevents restoring an active goal as a side effect
      // of trying to send an ordinary message after a CloudCLI restart.
      if (!alreadyOpen && this.threadId && (await this.readGoalWhenEnabled())?.status === 'active') {
        throw busyError();
      }
      await this.openThread(threadOptions, (nativeId, created) => {
        writer.setSessionId?.(nativeId);
        if (created) {
          sendMessage(writer, createNormalizedMessage({
            kind: 'session_created', newSessionId: nativeId, sessionId: nativeId, provider: 'codex',
          }));
        }
      });
      if (pending.stopped) {
        await this.finishPending(pending);
        return;
      }
      const connection = await this.connected.promise;
      // turn/start on 0.170 may implicitly steer an already running turn.
      // Keep ordinary input queued while the goal may autonomously start work.
      if (this.activeTurn || this.hasGoalTurn()) throw busyError();
      if (pending.stopped) {
        await this.finishPending(pending);
        return;
      }
      if (alreadyOpen && this.threadId) writer.setSessionId?.(this.threadId);
      const turnOverrides = this.readTurnOverrides(threadOptions);
      pending.sent = true;
      const response = readObjectRecord(await connection.call('turn/start', {
        threadId: this.threadId,
        input: buildTurnInput(command, options, threadOptions.cwd),
        effort: threadOptions.config?.model_reasoning_effort,
        ...turnOverrides,
      }));
      if (typeof response?.turn?.id !== 'string') throw new Error('Codex did not return a turn id.');
      // The notification normally arrives first. If it has not, seed the
      // same turn state from the reply without settling it.
      if (!pending.turn) this.startTurn(response.turn.id);
      if (!pending.turn) throw new Error('Codex did not open a turn for the input.');
      this.workingDirectory = threadOptions.cwd;
      this.threadOptions = threadOptions;
      await pending.done.promise;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CODEX_TURN_BUSY' && !pending.sent && !pending.stopped) {
        pending.done.resolve();
        throw error;
      }
      if (pending.turn) this.finishTurn(pending.turn, undefined, error);
      else await this.finishPending(pending, error);
    } finally {
      if (this.pendingTurn === pending) this.pendingTurn = undefined;
      this.closeIfIdle();
    }
  }

  private readTurnOverrides(options: ThreadOptions): AnyRecord {
    const previous = this.threadOptions;
    if (!previous) return {};
    const overrides: AnyRecord = {};
    if (options.cwd !== previous.cwd) overrides.cwd = options.cwd;
    if (options.model !== previous.model) overrides.model = options.model;
    if (options.approvalPolicy !== previous.approvalPolicy) overrides.approvalPolicy = options.approvalPolicy;
    if (options.sandbox !== previous.sandbox) {
      overrides.sandboxPolicy = options.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : {
          type: 'workspaceWrite', writableRoots: [options.cwd], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        };
    }
    return overrides;
  }

  private async finishPending(pending: PendingTurn, error?: unknown) {
    if (!pending.stopped && !(await this.context.isProviderInstalled().catch(() => true))) {
      error = new Error('Codex CLI is not configured. Please set up authentication first.');
    }
    this.finishWriter(pending.writer, pending.stopped, false, error);
    pending.done.resolve();
  }

  private startTurn(id: string): Turn | undefined {
    if (this.settledTurns.has(id)) return;
    if (this.activeTurn?.id === id) return this.activeTurn;
    if (this.activeTurn) return;
    const pending = this.pendingTurn?.sent && !this.pendingTurn.turn ? this.pendingTurn : undefined;
    const writer = pending?.writer ?? (this.threadId ? this.hooks?.startTurn(this.threadId, id) : null);
    if (!writer) return;
    const turn: Turn = {
      id, writer, cwd: pending?.cwd ?? this.workingDirectory, stopped: pending?.stopped ?? false,
      surfacedError: false, done: pending?.done ?? deferred<void>(),
      textByItem: new Map(), commands: new Map(), deliveredMessages: new Set(),
      pendingProgress: new Map(), compactions: new Map(),
    };
    this.activeTurn = turn;
    if (pending) pending.turn = turn;
    if (this.compaction?.sent && !this.compaction.turnId) this.compaction.turnId = id;
    this.emit(turn, createNormalizedMessage({
      kind: 'turn_started', turnId: id, provider: 'codex', sessionId: this.threadId,
    }));
    if (turn.stopped) void this.requestInterrupt(turn).catch(() => {});
    return turn;
  }

  private emit(turn: Turn, message: unknown) {
    sendMessage(turn.writer, message);
  }

  private emitRaw(turn: Turn, message: AnyRecord) {
    for (const normalized of this.context.normalizeMessage(message, this.threadId)) this.emit(turn, normalized);
  }

  private flushProgress(turn: Turn) {
    clearTimeout(turn.progressTimer);
    turn.progressTimer = undefined;
    for (const raw of turn.pendingProgress.values()) this.emitRaw(turn, raw);
    turn.pendingProgress.clear();
  }

  private emitProgress(turn: Turn, raw: AnyRecord) {
    if (turn.progressTimer) {
      turn.pendingProgress.set(raw.itemId, raw);
      return;
    }
    this.emitRaw(turn, raw);
    turn.progressTimer = setTimeout(() => {
      try {
        this.flushProgress(turn);
      } catch (error) {
        this.finishTurn(turn, undefined, error);
      }
    }, PROGRESS_INTERVAL_MS);
  }

  private emitCompaction(turn: Turn, item: AnyRecord, phase: CompactionInfo['phase'], error?: string) {
    const compact: CompactionInfo = {
      phase,
      trigger: this.compaction?.turnId === turn.id ? 'manual' : 'auto',
      nativeItemId: item.id,
      nativeTurnId: turn.id,
      boundaryIndex: [...turn.compactions.keys()].indexOf(item.id),
      ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
      ...(typeof item.preTokens === 'number' ? { preTokens: item.preTokens } : {}),
      ...(typeof item.postTokens === 'number' ? { postTokens: item.postTokens } : {}),
      ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
      ...(error ? { error } : {}),
    };
    this.emit(turn, createNormalizedMessage({
      kind: 'text', role: 'assistant', id: item.id, provider: 'codex', sessionId: this.threadId,
      turnId: turn.id, compact,
    }));
  }

  private handleItem(turn: Turn, item: AnyRecord, isComplete: boolean) {
    if (item.type === 'contextCompaction') {
      if (typeof item.id !== 'string') return;
      const previous = turn.compactions.get(item.id);
      const completed = isComplete || Boolean(previous?.completed);
      const merged = { ...previous?.item, ...item };
      turn.compactions.set(item.id, { item: merged, completed });
      const manual = this.compaction?.turnId === turn.id;
      if (!previous) this.emitCompaction(turn, merged, isComplete && !manual ? 'done' : 'running');
      else if (!previous.completed && isComplete && !manual) this.emitCompaction(turn, merged, 'done');
      if (manual && isComplete && turn.deferredTerminal) this.finishTurn(turn, turn.deferredTerminal);
      return;
    }
    if (item.type === 'userMessage') {
      // The gateway displays the original input optimistically. Steering
      // echoes carry a client id so they can be deduplicated on replay.
      if (this.threadId && typeof item.clientId === 'string' && !turn.deliveredMessages.has(item.clientId)) {
        turn.deliveredMessages.add(item.clientId);
        this.emit(turn, normalizeSteerEcho(item, this.threadId));
      }
      return;
    }
    if (item.type === 'commandExecution') {
      if (isComplete) {
        const previous = turn.commands.get(item.id);
        item = { ...item, aggregatedOutput: item.aggregatedOutput ?? previous?.aggregatedOutput };
        turn.commands.delete(item.id);
      } else {
        turn.commands.set(item.id, item);
      }
    }
    if (isComplete) turn.textByItem.delete(item.id);
    if (!isComplete && !['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) return;
    const raw = normalizeItem(item);
    if (raw) this.emitRaw(turn, raw);
  }

  private receive(method: string, value: unknown) {
    const params = readObjectRecord(value);
    if (this.closed || typeof params?.threadId !== 'string') return;
    if (!this.threadOpened) {
      if (this.opening && (!this.threadId || this.threadId === params.threadId)) this.earlyEvents.push([method, params]);
      return;
    }
    if (params.threadId !== this.threadId) return;
    try {
      if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
        ++this.goalVersion;
        this.setGoal(method === 'thread/goal/cleared' ? null : readGoal(params.goal, params.threadId));
        this.closeIfIdle();
        return;
      }
      if (method === 'thread/status/changed') {
        this.nativeThreadActive = params.status?.type === 'active';
        this.closeIfIdle();
        return;
      }
      const id = params.turn?.id ?? params.turnId;
      if (typeof id === 'string' && this.settledTurns.has(id)) return;
      if (method === 'turn/started') {
        if (typeof id === 'string') this.startTurn(id);
        return;
      }
      let turn = this.activeTurn;
      // The item carries a turn id even when its start event is reordered.
      if (!turn && typeof id === 'string'
        && (method.startsWith('item/') || (this.compaction?.sent && method === 'turn/completed'))) {
        turn = this.startTurn(id);
      }
      if (!turn || (typeof id === 'string' && turn.id !== id)) return;
      if (!method.endsWith('Delta')) this.flushProgress(turn);
      this.receiveTurnEvent(turn, method, params);
    } catch (error) {
      if (this.activeTurn) this.finishTurn(this.activeTurn, undefined, error);
      else if (this.compaction) this.compaction.done.resolve(controlFailed(error));
    }
  }

  private receiveTurnEvent(turn: Turn, method: string, params: AnyRecord) {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = readObjectRecord(params.item);
        if (item) this.handleItem(turn, item, method === 'item/completed');
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta': {
        const key = params.itemId;
        if (typeof key !== 'string' || typeof params.delta !== 'string') break;
        const text = (turn.textByItem.get(key) ?? '') + params.delta;
        turn.textByItem.set(key, text);
        this.emitProgress(turn, {
          type: 'item', itemId: key,
          itemType: method === 'item/agentMessage/delta' ? 'agent_message' : 'reasoning',
          message: { content: text },
        });
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const item = turn.commands.get(params.itemId);
        if (item && typeof params.delta === 'string') {
          item.aggregatedOutput = (item.aggregatedOutput ?? '') + params.delta;
          const raw = normalizeItem(item);
          if (raw) this.emitProgress(turn, raw);
        }
        break;
      }
      case 'turn/plan/updated':
        this.emitRaw(turn, {
          type: 'item', itemType: 'todo_list', itemId: `${turn.id}-plan`,
          items: Array.isArray(params.plan)
            ? params.plan.map((step: AnyRecord) => ({ text: step.step, completed: step.status === 'completed' }))
            : [],
        });
        break;
      case 'thread/tokenUsage/updated':
        if (params.tokenUsage?.total) {
          this.emit(turn, createNormalizedMessage({
            kind: 'status', text: 'token_budget', tokenBudget: readTokenBudget(params.tokenUsage),
            sessionId: this.threadId, provider: 'codex',
          }));
        }
        break;
      case 'error': {
        if (params.willRetry || turn.stopped) break;
        const content = params.error?.message || 'Codex encountered an error.';
        if (this.compaction?.turnId === turn.id) {
          turn.compactionError = new Error(content);
        } else if (!turn.surfacedError) {
          turn.surfacedError = true;
          this.emit(turn, createNormalizedMessage({
            kind: 'error', provider: 'codex', sessionId: this.threadId, content,
          }));
        }
        break;
      }
      case 'turn/completed': {
        const terminal = params.turn;
        if (terminal?.id !== turn.id || turn.deferredTerminal) break;
        if (this.compaction?.turnId === turn.id && terminal.status === 'completed'
          && !turn.compactionError && ![...turn.compactions.values()].some((item) => item.completed)) {
          // A reordered terminal event can arrive before its compaction item.
          turn.deferredTerminal = terminal;
          turn.terminalTimer = setTimeout(() => this.finishTurn(turn, terminal), PROGRESS_INTERVAL_MS);
        } else {
          this.finishTurn(turn, terminal);
        }
        break;
      }
    }
  }

  private finishTurn(turn: Turn, terminal?: AnyRecord, error?: unknown) {
    if (this.activeTurn !== turn) return;
    this.activeTurn = undefined;
    clearTimeout(turn.terminalTimer);
    try {
      this.flushProgress(turn);
    } catch (flushError) {
      error ??= flushError;
    }
    this.settledTurns.add(turn.id);
    if (this.settledTurns.size > 64) {
      const oldestId = this.settledTurns.values().next().value;
      if (oldestId) this.settledTurns.delete(oldestId);
    }

    const manual = this.compaction?.turnId === turn.id ? this.compaction : undefined;
    const aborted = turn.stopped || terminal?.status === 'interrupted';
    error ??= turn.compactionError;
    if (terminal?.status === 'failed') error ??= new Error(terminal.error?.message || 'Codex turn failed.');
    const completed = terminal?.status === 'completed' && !aborted && !error;
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    for (const item of turn.compactions.values()) {
      if (!manual && item.completed) continue;
      const succeeded = item.completed && completed;
      this.emitCompaction(turn, item.item, succeeded ? 'done' : 'failed', succeeded ? undefined : message);
    }

    if (manual) {
      const compacted = completed && [...turn.compactions.values()].some((item) => item.completed);
      this.emit(turn, createCompleteMessage({
        provider: 'codex', sessionId: this.threadId, exitCode: compacted ? 0 : 1,
        aborted, turnSettleConfirmed: Boolean(terminal),
      }));
      manual.done.resolve(compacted
        ? { status: 'completed' }
        : { status: 'failed', code: aborted ? 'COMPACT_INTERRUPTED' : 'COMPACT_FAILED', error: message });
    } else {
      this.finishWriter(turn.writer, aborted, Boolean(terminal), error, turn.surfacedError);
    }
    turn.done.resolve();
    this.closeIfIdle();
  }

  private finishWriter(
    writer: ProviderRuntimeWriter,
    aborted: boolean,
    confirmed: boolean,
    error?: unknown,
    surfacedError = false,
  ) {
    const sessionId = this.threadId || this.appSessionId;
    const notification = {
      userId: writer.userId || null,
      provider: 'codex',
      sessionId: this.appSessionId || sessionId,
      sessionName: this.sessionSummary,
    };
    if (error && !aborted && !surfacedError) {
      sendMessage(writer, createNormalizedMessage({
        kind: 'error', provider: 'codex', sessionId,
        content: error instanceof Error ? error.message : String(error),
      }));
    }
    sendMessage(writer, createCompleteMessage({
      provider: 'codex', sessionId, exitCode: aborted || error ? 1 : 0,
      aborted, turnSettleConfirmed: confirmed,
    }));
    if (error && !aborted) notifyRunFailed({ ...notification, error } as Parameters<typeof notifyRunFailed>[0]);
    else notifyRunStopped({
      ...notification, stopReason: aborted ? 'aborted' : 'completed',
    } as Parameters<typeof notifyRunStopped>[0]);
  }

  private setGoal(goal: CodexGoal | null) {
    this.goal = goal;
    this.hooks?.publishGoal(goal);
  }

  private closeIfIdle() {
    if (this.blocksUserTurn()) return;
    if (this.goalReaders === 0) this.close();
    this.hooks?.onIdle();
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    const key = this.appSessionId || this.threadId;
    if (key && sessions.get(key) === this) sessions.delete(key);
    this.lifetime.resolve();
  }

  private onExit(error: unknown) {
    if (this.closed) return;
    this.connected.reject(error);
    this.close();
    this.nativeThreadActive = false;
    if (this.activeTurn) this.finishTurn(this.activeTurn, undefined, error);
    this.compaction?.done.resolve(controlFailed(error));
    this.hooks?.onIdle();
  }

  private async requestInterrupt(turn: Turn) {
    const connection = await this.connected.promise;
    await connection.call('turn/interrupt', { threadId: this.threadId, turnId: turn.id });
  }

  async abort(expectedTurnId?: string): Promise<boolean> {
    const turn = this.activeTurn;
    const pending = this.pendingTurn;
    if (expectedTurnId && expectedTurnId !== turn?.id) return false;
    if (!turn) {
      if (!pending || pending.turn) return false;
      pending.stopped = true;
      if (!this.threadOpened || pending.sent) this.controller.abort();
      await pending.done.promise;
      return true;
    }

    if (!turn.stopped) {
      turn.stopped = true;
      const timeout = setTimeout(() => this.controller.abort(), INTERRUPT_GRACE_MS);
      timeout.unref();
      void this.requestInterrupt(turn).catch(() => {});
      await turn.done.promise;
      clearTimeout(timeout);
    }
    await turn.done.promise;
    return true;
  }

  async steer(command: string, options: AnyRecord): Promise<boolean> {
    const turn = this.activeTurn;
    if (!turn || turn.stopped || options.expectedTurnId !== turn.id || this.compaction?.turnId === turn.id) return false;
    try {
      const connection = await this.connected.promise;
      if (this.activeTurn !== turn || turn.stopped) return false;
      const result = readObjectRecord(await connection.call('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: turn.id,
        clientUserMessageId: options.messageId,
        input: buildTurnInput(command, options, turn.cwd),
      }));
      if (result?.turnId !== turn.id) throw new Error('Codex returned an unexpected turn for the message.');
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_ERROR'
        && /^(?:no active turn to steer|expected active turn id |cannot steer a (?:review|compact) turn)/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  private async getGoal(): Promise<CodexGoal | null> {
    const threadId = this.threadId;
    if (!threadId) return null;
    this.goalReaders++;
    try {
      const connection = await this.connected.promise;
      const version = this.goalVersion;
      const response = readObjectRecord(await connection.call('thread/goal/get', { threadId }));
      const goal = readGoal(response?.goal, threadId);
      if (version === this.goalVersion) this.goal = goal;
      return this.goal;
    } finally {
      this.goalReaders--;
    }
  }

  private async readGoalWhenEnabled(): Promise<CodexGoal | null> {
    try {
      return await this.getGoal();
    } catch (error) {
      // Goals are configurable independently of ordinary chat and compaction.
      if (error instanceof AppError && /^(?:goals feature is disabled|sqlite state db unavailable for thread goals)$/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async control(options: AnyRecord, operation: ChatCodexOperation, hooks: CodexControlHooks): Promise<CodexControlResult> {
    if (operation.kind === 'compact') return this.compact(options, hooks);
    if (operation.action === 'get') {
      try {
        const goal = await this.getGoal();
        hooks.onAccepted();
        return { status: 'completed', goal };
      } catch (error) {
        return controlFailed(error);
      } finally {
        // A metadata-only read must not start a thread or retain a child just
        // because the goal stored on disk is active.
        if (this.goalReaders === 0 && !this.blocksUserTurn()) this.close();
      }
    }
    if (this.compaction) return controlRejected('GOAL_COMPACTION_IN_PROGRESS');
    this.closeIfIdle();
    return controlRejected('GOAL_UNAVAILABLE');
  }

  private async compact(options: AnyRecord, hooks: CodexControlHooks): Promise<CodexControlResult> {
    if (!this.threadId) {
      this.closeIfIdle();
      return controlRejected('COMPACT_NO_HISTORY');
    }
    if (this.compaction || this.hasCompactionConflict(hooks)) {
      this.closeIfIdle();
      return controlRejected('COMPACT_BUSY');
    }

    // Reserve before the first await so a resume, ordinary send or another
    // compaction cannot pass the same idle check before the RPC is sent.
    const operation: PendingCompaction = { done: deferred<CodexControlResult>(), sent: false };
    this.compaction = operation;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const connection = await this.connected.promise;
      const threadId = this.threadId;
      const goal = await this.readGoalWhenEnabled();
      if (goal?.status === 'active') return controlRejected('COMPACT_GOAL_ACTIVE');

      const page = readObjectRecord(await connection.call('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' })
        .catch((error: unknown) => {
          if (error instanceof AppError && error.message.includes('not materialized yet')) return { data: [] };
          throw error;
        }));
      if (!Array.isArray(page?.data) || page.data.length === 0) return controlRejected('COMPACT_NO_HISTORY');

      await this.openThreadForControl(options, hooks);
      if (this.hasCompactionConflict(hooks)) return controlRejected('COMPACT_BUSY');
      if (this.goal?.status === 'active') return controlRejected('COMPACT_GOAL_ACTIVE');
      operation.sent = true;
      await connection.call('thread/compact/start', { threadId });
      hooks.onAccepted();
      deadline = setTimeout(() => {
        if (this.activeTurn && this.activeTurn.id === operation.turnId) {
          this.finishTurn(this.activeTurn, undefined, new Error('Codex did not report the end of compaction.'));
        } else {
          operation.done.resolve({ status: 'failed', code: 'COMPACT_FAILED' });
        }
        // Native state is ambiguous. Reopen it before accepting more work.
        this.controller.abort();
      }, COMPACTION_TIMEOUT_MS);
      deadline.unref();
      return await operation.done.promise;
    } catch (error) {
      if (this.activeTurn && this.activeTurn.id === operation.turnId) this.finishTurn(this.activeTurn, undefined, error);
      return controlFailed(error);
    } finally {
      clearTimeout(deadline);
      if (this.compaction === operation) this.compaction = undefined;
      this.closeIfIdle();
    }
  }

  private hasCompactionConflict(hooks: CodexControlHooks): boolean {
    return Boolean(this.activeTurn || this.pendingTurn || this.nativeThreadActive || hooks.isTurnRunning());
  }

}

function getThreadConnection(
  sessionId: string | undefined,
  context: ProviderRuntimeContext,
  hooks?: CodexControlHooks,
  preserveExistingHooks = false,
) {
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing && !existing.releaseReadConnectionIfRepointed(context.resolveProviderSessionId(sessionId))) {
    if (!preserveExistingHooks) existing.setHooks(hooks);
    return existing;
  }
  const connection = new CodexThreadConnection(sessionId, context, hooks);
  if (sessionId) sessions.set(sessionId, connection);
  return connection;
}

async function queryCodex(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  return getThreadConnection(options.sessionId, context, options.codexHooks).run(command, options, writer);
}

async function controlCodex(
  sessionId: string,
  options: AnyRecord,
  operation: ChatCodexOperation,
  hooks: CodexControlHooks,
  context: ProviderRuntimeContext,
): Promise<CodexControlResult> {
  if (!sessions.has(sessionId) && !context.resolveProviderSessionId(sessionId)) {
    if (operation.kind === 'compact') return controlRejected('COMPACT_NO_HISTORY');
    if (operation.action === 'get') return { status: 'completed', goal: null };
    if (operation.action === 'clear') return { status: 'completed', cleared: false, goal: null };
    if (operation.action !== 'set') return controlRejected('GOAL_NO_GOAL', null);
  }
  const readOnly = operation.kind === 'goal' && operation.action === 'get';
  return getThreadConnection(sessionId, context, hooks, readOnly).control({ ...options, sessionId }, operation, hooks);
}

function isCodexControlBlockingTurn(sessionId: string): boolean {
  return sessions.get(sessionId)?.blocksUserTurn() ?? false;
}

async function abortCodexSession(sessionId: string, expectedTurnId?: string): Promise<boolean> {
  return (await sessions.get(sessionId)?.abort(expectedTurnId)) ?? false;
}

async function steerCodexSession(sessionId: string, command: string, options: AnyRecord): Promise<boolean> {
  return (await sessions.get(sessionId)?.steer(command, options)) ?? false;
}

/**
 * Answers one side question on `request.providerSessionId` through
 * `codexAppServer.askSideQuestion` (an ephemeral, read-only fork — see its
 * doc comment), without touching the parent thread or its live connection.
 *
 * Never throws: a missing provider session (no prior turn to fork from, or a
 * resume id not yet captured) and any rejection from the app-server both
 * resolve as an error outcome, as `SideQuestionRuntime` requires.
 */
async function askCodexSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
  _context: ProviderRuntimeContext,
): Promise<SideQuestionOutcome> {
  if (!request.providerSessionId) {
    return { status: 'error', error: 'This Codex session has no provider thread to ask a side question on yet.', answer: '' };
  }

  let answer = '';
  try {
    const text = await codexAppServer.askSideQuestion({
      threadId: request.providerSessionId,
      cwd: request.projectPath || '',
      model: request.model || '',
      question: request.question,
      signal: request.signal,
    }, (delta) => {
      answer += delta;
      sink.delta(delta);
    });
    return { status: 'done', answer: text };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error), answer };
  }
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isWebSocketWriter) {
      // The gateway writer handles stringification
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

/** Used by CodexProvider to run, steer and interrupt App Server turns. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  steer: steerCodexSession,
  controlCodex,
  isCodexControlBlockingTurn,
  askSideQuestion: askCodexSideQuestion,
};
