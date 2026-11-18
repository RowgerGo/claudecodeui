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
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SideQuestionOutcome,
  SideQuestionRequest,
  SideQuestionSink,
} from '@/shared/types.js';

import { codexAppServer } from './codex-app-server.client.js';

type ActiveCodexSession = {
  controller: AbortController;
  finished: Promise<void>;
  ending: boolean;
  stopped: boolean;
  steer?: (command: string, options: AnyRecord) => Promise<boolean>;
  interrupt?: () => Promise<void>;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();
const INTERRUPT_GRACE_MS = 5_000;
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

function mapPermissionMode(permissionMode: unknown) {
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

async function queryCodex(
  command: string,
  options: AnyRecord = {},
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const { sessionId, sessionSummary, cwd, projectPath, model, effort, permissionMode } = options;
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const workingDirectory = cwd || projectPath || process.cwd();
  let threadId = providerSessionId;
  let terminalTurn: AnyRecord | undefined;
  let surfacedError = false;
  const finished = deferred<void>();
  const run: ActiveCodexSession = {
    controller: new AbortController(),
    finished: finished.promise,
    ending: false,
    stopped: false,
  };

  if (sessionId) activeCodexSessions.set(sessionId, run);
  const emit = (message: unknown) => sendMessage(writer, message);
  const notify = () => ({
    userId: writer.userId || null,
    provider: 'codex' as const,
    sessionId: sessionId || threadId,
    sessionName: sessionSummary,
  });

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, model);
    const catalog = await context.getProviderModels();
    const modelInfo = catalog.OPTIONS.find((option) => option.value === resolvedModel);
    const resolvedEffort = effort !== 'default' && modelInfo?.effort?.values?.some((value) => value.value === effort)
      ? effort
      : undefined;
    const threadOptions = {
      cwd: workingDirectory,
      model: resolvedModel,
      ...mapPermissionMode(permissionMode),
      config: resolvedEffort ? { model_reasoning_effort: resolvedEffort } : undefined,
    };
    const input = buildTurnInput(command, options, workingDirectory);

    run.controller.signal.throwIfAborted();
    await codexAppServer.withChatConnection(async ({ call, onNotification, onExit }) => {
      const opened = readObjectRecord(providerSessionId
        ? await call('thread/resume', { ...threadOptions, threadId: providerSessionId, excludeTurns: true })
        : await call('thread/start', threadOptions));
      const nativeId = opened?.thread?.id;
      if (typeof nativeId !== 'string' || (providerSessionId && nativeId !== providerSessionId)) {
        throw new Error('Codex did not open the requested thread.');
      }
      threadId = nativeId;
      if (!sessionId) activeCodexSessions.set(nativeId, run);
      const emitRaw = (raw: AnyRecord) => {
        for (const message of context.normalizeMessage(raw, nativeId)) emit(message);
      };

      const completed = deferred<void>();
      const textByItem = new Map<string, string>();
      const commands = new Map<string, AnyRecord>();
      const deliveredMessages = new Set<string>();
      // Send a preview immediately, then keep only the latest cumulative
      // snapshot per item between flushes. This limits replay buffer churn.
      const pendingProgress = new Map<string, AnyRecord>();
      let progressTimer: NodeJS.Timeout | undefined;
      const flushProgress = () => {
        clearTimeout(progressTimer);
        progressTimer = undefined;
        for (const raw of pendingProgress.values()) emitRaw(raw);
        pendingProgress.clear();
      };
      const emitProgress = (raw: AnyRecord) => {
        if (progressTimer) {
          pendingProgress.set(raw.itemId, raw);
          return;
        }
        emitRaw(raw);
        progressTimer = setTimeout(() => {
          try {
            flushProgress();
          } catch (error) {
            completed.reject(error);
          }
        }, PROGRESS_INTERVAL_MS);
      };
      let turnId: string | undefined;

      const registerTurn = (id: unknown) => {
        if (typeof id !== 'string' || turnId || run.ending) return;
        turnId = id;
        run.interrupt = async () => {
          await call('turn/interrupt', { threadId: nativeId, turnId: id });
        };
        run.steer = async (newCommand, steerOptions) => {
          if (run.ending || run.stopped || steerOptions.expectedTurnId !== id) return false;
          try {
            const result = readObjectRecord(await call('turn/steer', {
              threadId: nativeId,
              expectedTurnId: id,
              clientUserMessageId: steerOptions.messageId,
              input: buildTurnInput(newCommand, steerOptions, workingDirectory),
            }));
            if (result?.turnId !== id) throw new Error('Codex returned an unexpected turn for the message.');
            return true;
          } catch (error) {
            if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_ERROR'
              && /^(?:no active turn to steer|expected active turn id |cannot steer a (?:review|compact) turn)/.test(error.message)) {
              return false;
            }
            throw error;
          }
        };
        emit(createNormalizedMessage({ kind: 'turn_started', turnId, provider: 'codex', sessionId: nativeId }));
      };

      const handleItem = (item: AnyRecord, isComplete: boolean) => {
        if (item.type === 'userMessage') {
          // The first prompt is written optimistically by the gateway. Only
          // its subsequent steering messages have a client id in our turns.
          if (typeof item.clientId === 'string' && !deliveredMessages.has(item.clientId)) {
            deliveredMessages.add(item.clientId);
            emit(normalizeSteerEcho(item, nativeId));
          }
          return;
        }
        if (item.type === 'commandExecution') {
          if (isComplete) {
            const previous = commands.get(item.id);
            item = { ...item, aggregatedOutput: item.aggregatedOutput ?? previous?.aggregatedOutput };
            commands.delete(item.id);
          } else {
            commands.set(item.id, item);
          }
        }
        if (isComplete) textByItem.delete(item.id);
        if (!isComplete && !['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) return;
        const raw = normalizeItem(item);
        if (raw) emitRaw(raw);
      };

      const stopNotifications = onNotification((method, value) => {
        const params = readObjectRecord(value);
        if (run.ending || params?.threadId !== nativeId) return;
        const eventTurnId = params.turn?.id ?? params.turnId;
        if (turnId && eventTurnId && eventTurnId !== turnId) return;
        try {
          if (!method.endsWith('Delta')) flushProgress();
          switch (method) {
            case 'turn/started':
              registerTurn(eventTurnId);
              break;
            case 'item/started':
            case 'item/completed': {
              const item = readObjectRecord(params.item);
              if (item) handleItem(item, method === 'item/completed');
              break;
            }
            case 'item/agentMessage/delta':
            case 'item/reasoning/summaryTextDelta': {
              const key = params.itemId;
              if (typeof key !== 'string' || typeof params.delta !== 'string') break;
              const text = (textByItem.get(key) ?? '') + params.delta;
              textByItem.set(key, text);
              emitProgress({
                type: 'item',
                itemId: key,
                itemType: method === 'item/agentMessage/delta' ? 'agent_message' : 'reasoning',
                message: { content: text },
              });
              break;
            }
            case 'item/commandExecution/outputDelta': {
              const item = commands.get(params.itemId);
              if (item && typeof params.delta === 'string') {
                item.aggregatedOutput = (item.aggregatedOutput ?? '') + params.delta;
                const raw = normalizeItem(item);
                if (raw) emitProgress(raw);
              }
              break;
            }
            case 'turn/plan/updated':
              emitRaw({
                type: 'item',
                itemType: 'todo_list',
                itemId: `${eventTurnId}-plan`,
                items: Array.isArray(params.plan)
                  ? params.plan.map((step: AnyRecord) => ({ text: step.step, completed: step.status === 'completed' }))
                  : [],
              });
              break;
            case 'thread/tokenUsage/updated':
              if (params.tokenUsage?.total) {
                emit(createNormalizedMessage({
                  kind: 'status',
                  text: 'token_budget',
                  tokenBudget: readTokenBudget(params.tokenUsage),
                  sessionId: nativeId,
                  provider: 'codex',
                }));
              }
              break;
            case 'error':
              if (!params.willRetry && !surfacedError && !run.stopped) {
                surfacedError = true;
                emit(createNormalizedMessage({
                  kind: 'error', provider: 'codex', sessionId: nativeId,
                  content: params.error?.message || 'Codex encountered an error.',
                }));
              }
              break;
            case 'turn/completed':
              if (!params.turn?.id) break;
              terminalTurn = params.turn;
              run.ending = true;
              completed.resolve();
              break;
          }
        } catch (error) {
          completed.reject(error);
        }
      });
      const stopExit = onExit((reason) => completed.reject(new Error(reason)));

      writer.setSessionId?.(nativeId);
      if (!providerSessionId) {
        emit(createNormalizedMessage({ kind: 'session_created', newSessionId: nativeId, sessionId: nativeId, provider: 'codex' }));
      }
      try {
        await Promise.all([
          call('turn/start', { threadId: nativeId, input, effort: resolvedEffort }).then((value) => {
            const started = readObjectRecord(value);
            if (typeof started?.turn?.id !== 'string') throw new Error('Codex did not return a turn id.');
            registerTurn(started.turn.id);
          }),
          completed.promise,
        ]);
      } finally {
        clearTimeout(progressTimer);
        stopNotifications();
        stopExit();
      }
    }, run.controller.signal);

    if (terminalTurn?.status === 'failed' && !run.stopped) {
      throw new Error(terminalTurn.error?.message || 'Codex turn failed.');
    }
    const aborted = run.stopped || terminalTurn?.status === 'interrupted';
    emit(createCompleteMessage({
      provider: 'codex', sessionId: threadId || sessionId,
      exitCode: aborted ? 1 : 0, aborted, turnSettleConfirmed: Boolean(terminalTurn),
    }));
    notifyRunStopped({ ...notify(), stopReason: aborted ? 'aborted' : 'completed' });
  } catch (error) {
    run.ending = true;
    if (run.stopped) {
      emit(createCompleteMessage({ provider: 'codex', sessionId: threadId || sessionId, exitCode: 1, aborted: true }));
      notifyRunStopped({ ...notify(), stopReason: 'aborted' });
    } else {
      if (!surfacedError) {
        const installed = await context.isProviderInstalled().catch(() => true);
        emit(createNormalizedMessage({
          kind: 'error',
          provider: 'codex',
          sessionId: threadId || sessionId,
          content: installed
            ? (error instanceof Error ? error.message : String(error))
            : 'Codex CLI is not configured. Please set up authentication first.',
        }));
      }
      emit(createCompleteMessage({
        provider: 'codex', sessionId: threadId || sessionId, exitCode: 1,
        turnSettleConfirmed: Boolean(terminalTurn),
      }));
      notifyRunFailed({ ...notify(), error });
    }
  } finally {
    const key = sessionId || threadId;
    if (key && activeCodexSessions.get(key) === run) activeCodexSessions.delete(key);
    finished.resolve();
  }
}

async function abortCodexSession(sessionId: string): Promise<boolean> {
  const run = activeCodexSessions.get(sessionId);
  if (!run) return false;
  if (run.ending) {
    await run.finished;
    return false;
  }

  if (!run.stopped) {
    run.stopped = true;
    if (run.interrupt) {
      const timeout = setTimeout(() => run.controller.abort(), INTERRUPT_GRACE_MS);
      timeout.unref();
      // The interrupt reply and terminal notification may arrive in either
      // order. Wait for the turn settlement, with a bounded process fallback.
      void run.interrupt().catch(() => {});
      await run.finished;
      clearTimeout(timeout);
    } else {
      run.controller.abort();
    }
  }
  await run.finished;
  return true;
}

async function steerCodexSession(sessionId: string, command: string, options: AnyRecord): Promise<boolean> {
  return (await activeCodexSessions.get(sessionId)?.steer?.(command, options)) ?? false;
}

/**
 * Answers one side question on `request.providerSessionId` through
 * `codexAppServer.askSideQuestion` (an ephemeral, read-only fork — see its
 * doc comment), without touching the parent thread or `activeCodexSessions`.
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
  askSideQuestion: askCodexSideQuestion,
};
