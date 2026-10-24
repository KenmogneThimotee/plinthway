import {
  canonicalJson,
  PlinthwayError,
  newEventId,
  newExecutionId,
  redact,
  type ExecutionEvent,
  type ExecutionId,
  type JsonValue,
  type LLMEvent,
  type LLMMessage,
  type LLMRequest,
  type SessionId,
  type ToolCall,
  type ToolProvider,
} from '@plinthway/shared';
import type { LLMRuntime } from '@plinthway/llm-runtime';
import { PolicyEngine, type ApprovalBroker } from '@plinthway/policy';
import type { SessionRepository } from '@plinthway/sessions';

import { ExecutionGate } from './execution-gate.js';
import { ToolRunner } from './tool-runner.js';

export interface AgentEngineOptions {
  readonly llm: LLMRuntime;
  readonly tools: ToolProvider;
  readonly skillContexts?: () => readonly string[];
  readonly approvals: ApprovalBroker;
  readonly sessions: SessionRepository;
  readonly gate?: ExecutionGate;
  readonly newExecutionId?: () => ExecutionId;
  readonly clock?: () => Date;
  readonly modelTurnTimeoutMs?: number;
  readonly stderr?: { readonly write: (value: string) => unknown };
}

export interface AgentRunInput {
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

interface ResolvedAgentEngineOptions {
  readonly llm: LLMRuntime;
  readonly tools: ToolProvider;
  readonly skillContexts?: () => readonly string[];
  readonly approvals: ApprovalBroker;
  readonly sessions: SessionRepository;
  readonly gate: ExecutionGate;
  readonly newExecutionId: () => ExecutionId;
  readonly clock: () => Date;
  readonly modelTurnTimeoutMs: number;
  readonly stderr: { readonly write: (value: string) => unknown };
}

function asError(error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  if (error instanceof Error) {
    return new PlinthwayError('PROVIDER_ERROR', error.message, {}, { cause: error });
  }
  return new PlinthwayError('PROVIDER_ERROR', 'Agent execution failed');
}

function isRetryable(error: PlinthwayError): boolean {
  return error.code === 'RATE_LIMITED' || error.code === 'PROVIDER_ERROR';
}

function abortError(signal: AbortSignal): PlinthwayError {
  return signal.reason instanceof PlinthwayError
    ? signal.reason
    : new PlinthwayError('CANCELLED', 'Execution was cancelled');
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

type NewExecutionEvent = ExecutionEvent extends infer Candidate
  ? Candidate extends ExecutionEvent
    ? Omit<Candidate, 'eventId' | 'createdAt'>
    : never
  : never;

function event(now: () => Date, value: NewExecutionEvent): ExecutionEvent {
  return {
    eventId: newEventId(),
    createdAt: now().toISOString(),
    ...value,
  };
}

function safeDetails(error: PlinthwayError): JsonValue {
  return redact(error.details) as JsonValue;
}

export class AgentEngine {
  readonly #options: ResolvedAgentEngineOptions;

  constructor(options: AgentEngineOptions) {
    this.#options = {
      ...options,
      gate: options.gate ?? new ExecutionGate(),
      newExecutionId: options.newExecutionId ?? newExecutionId,
      clock: options.clock ?? (() => new Date()),
      modelTurnTimeoutMs: options.modelTurnTimeoutMs ?? 300_000,
      stderr: options.stderr ?? process.stderr,
    };
  }

  get executionGate(): ExecutionGate {
    return this.#options.gate;
  }

  async *run(input: AgentRunInput): AsyncGenerator<LLMEvent, void, void> {
    const session = await this.#options.sessions.get(input.sessionId);
    const executionId = this.#options.newExecutionId();
    const lease = this.#options.gate.begin(executionId, input.signal);
    const now = this.#options.clock;
    let sequence = session.lastSequence;
    let started = false;
    let terminalPromise: Promise<void> | undefined;

    const append = async (
      values: readonly ExecutionEvent[],
      status?: 'running' | 'completed' | 'cancelled' | 'failed',
    ): Promise<void> => {
      const updated = await this.#options.sessions.appendBatch(
        input.sessionId,
        sequence,
        values,
        status,
      );
      sequence = updated.lastSequence;
    };

    const terminalize = (
      status: 'completed' | 'cancelled' | 'failed',
      cause?: PlinthwayError,
    ): Promise<void> => {
      if (terminalPromise !== undefined) return terminalPromise;
      terminalPromise = (async () => {
        const terminalEvents: ExecutionEvent[] = [];
        if (cause !== undefined && status === 'failed') {
          terminalEvents.push(
            event(now, {
              type: 'execution-error',
              code: cause.code,
              message: cause.message,
              details: safeDetails(cause),
            }),
          );
        }
        terminalEvents.push(event(now, { type: 'execution-finished', status }));
        await append(terminalEvents, status);
      })();
      return terminalPromise;
    };

    try {
      await append(
        [
          event(now, { type: 'user-message', content: input.prompt }),
          event(now, { type: 'execution-started', executionId }),
        ],
        'running',
      );
      started = true;

      const profile = session.profile;
      const modelRef = session.modelOverride ?? profile.model.primary;
      const model = await this.#options.llm.resolve(
        modelRef,
        {
          toolCalls: this.#options.tools.listTools().length > 0,
        },
        {
          profileId: profile.id,
          providers: profile.resolvedProviders,
        },
      );
      await append([event(now, { type: 'model-selected', modelRef })]);
      const messages: LLMMessage[] = [
        ...(profile.resolvedInstructions === undefined
          ? []
          : ([{ role: 'system', content: profile.resolvedInstructions }] satisfies LLMMessage[])),
        ...((this.#options.skillContexts?.() ?? []).map((content) => ({
          role: 'system' as const,
          content,
        })) satisfies LLMMessage[]),
        ...(await this.#options.sessions.reconstructMessages(input.sessionId)),
      ];
      const tools = this.#options.tools.listTools().map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      }));
      const policy = new PolicyEngine({
        enabledServers: profile.mcp.enabled,
        defaultPolicy: profile.tools.defaultPolicy,
        rules: profile.tools.rules,
        tools: this.#options.tools.listTools(),
      });
      const toolRunner = new ToolRunner({
        policy,
        approvals: this.#options.approvals,
        mcp: this.#options.tools,
        sessionId: input.sessionId,
        executionId,
        profileGenerationId: profile.generationId,
        timeoutMs: (profile.agent.toolTimeoutSeconds ?? 30) * 1_000,
      });
      let repeatedFailureKey: string | undefined;
      let repeatedFailures = 0;

      for (let step = 1; step <= profile.agent.maxSteps; step += 1) {
        if (lease.signal.aborted) throw abortError(lease.signal);
        const turnController = new AbortController();
        const onRunAbort = (): void => {
          turnController.abort(abortError(lease.signal));
        };
        lease.signal.addEventListener('abort', onRunAbort, { once: true });
        const timeout = setTimeout(() => {
          turnController.abort(new PlinthwayError('TIMEOUT', 'Model turn timed out'));
        }, this.#options.modelTurnTimeoutMs);
        const request: LLMRequest = {
          model,
          messages,
          ...(tools.length === 0 ? {} : { tools }),
          parameters: profile.model.parameters,
          timeoutMs: this.#options.modelTurnTimeoutMs,
        };
        let text = '';
        const calls: ToolCall[] = [];
        let usage: Extract<LLMEvent, { type: 'usage' }> | undefined;
        let finish: Extract<LLMEvent, { type: 'finish' }> | undefined;
        let attempt = 0;
        try {
          let retrying = true;
          while (retrying) {
            let receivedOutput = false;
            const stream = this.#options.llm.stream(request, turnController.signal);
            const iterator = stream[Symbol.asyncIterator]();
            try {
              let streaming = true;
              while (streaming) {
                const next = await nextWithAbort(iterator, turnController.signal);
                if (next.done) {
                  streaming = false;
                  continue;
                }
                if (turnController.signal.aborted) throw abortError(turnController.signal);
                receivedOutput = true;
                const llmEvent = next.value;
                if (llmEvent.type === 'text-delta') text += llmEvent.text;
                else if (llmEvent.type === 'tool-call') {
                  calls.push({
                    callId: llmEvent.callId,
                    toolName: llmEvent.toolName,
                    input: llmEvent.input,
                  });
                } else if (llmEvent.type === 'usage') usage = llmEvent;
                else if (llmEvent.type === 'finish') finish = llmEvent;
                yield llmEvent;
              }
              retrying = false;
            } catch (error) {
              await iterator.return?.();
              const typed = asError(error);
              if (receivedOutput || attempt >= 2 || !isRetryable(typed)) throw typed;
              attempt += 1;
            }
          }
        } finally {
          clearTimeout(timeout);
          lease.signal.removeEventListener('abort', onRunAbort);
        }

        const turnEvents: ExecutionEvent[] = [];
        if (text.length > 0) {
          turnEvents.push(event(now, { type: 'assistant-message', content: text }));
        }
        if (usage !== undefined) {
          turnEvents.push(
            event(now, {
              type: 'usage-recorded',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            }),
          );
        }
        for (const call of calls) turnEvents.push(event(now, { type: 'tool-requested', call }));
        if (turnEvents.length > 0) await append(turnEvents);

        if (calls.length === 0) {
          if (finish?.reason === 'cancelled')
            throw new PlinthwayError('CANCELLED', 'Model cancelled');
          if (finish?.reason === 'error')
            throw new PlinthwayError('PROVIDER_ERROR', 'Model failed');
          await terminalize('completed');
          return;
        }

        messages.push({ role: 'assistant', content: text, toolCalls: calls });
        for (const call of calls) {
          const outcome = await toolRunner.run(call, lease.signal);
          if (outcome.approvalDecision !== undefined) {
            sequence = (await this.#options.sessions.get(input.sessionId)).lastSequence;
          }
          const outcomeEvents: ExecutionEvent[] = [
            event(now, {
              type: 'policy-decided',
              callId: call.callId,
              action: outcome.decision.action,
              reason: outcome.decision.reason,
            }),
          ];
          outcomeEvents.push(
            event(now, {
              type: 'tool-result',
              callId: call.callId,
              toolName: call.toolName,
              result: outcome.result.content,
              trusted: false,
              isError: outcome.result.isError,
            }),
          );
          await append(outcomeEvents);
          messages.push({
            role: 'tool',
            callId: call.callId,
            toolName: call.toolName,
            content: outcome.result.content,
          });

          const failureKey = `${call.toolName}:${canonicalJson(call.input)}`;
          if (outcome.result.isError) {
            repeatedFailures = repeatedFailureKey === failureKey ? repeatedFailures + 1 : 1;
            repeatedFailureKey = failureKey;
            if (repeatedFailures >= 3) {
              throw new PlinthwayError('STEP_LIMIT', 'Repeated tool failure limit reached', {
                toolName: call.toolName,
              });
            }
          } else {
            repeatedFailureKey = undefined;
            repeatedFailures = 0;
          }
        }
      }
      throw new PlinthwayError('STEP_LIMIT', 'Agent step limit reached');
    } catch (error) {
      const typed = asError(error);
      if (started) {
        const status = typed.code === 'CANCELLED' ? 'cancelled' : 'failed';
        try {
          await terminalize(status, typed);
        } catch (persistenceError) {
          this.#options.stderr.write(
            `${JSON.stringify(redact({ code: 'STORAGE_ERROR', message: 'Terminal persistence failed' }))}\n`,
          );
          throw asError(persistenceError);
        }
      }
      throw typed;
    } finally {
      if (started && terminalPromise === undefined) {
        this.#options.gate.cancel();
        try {
          await terminalize('cancelled');
        } catch {
          this.#options.stderr.write(
            `${JSON.stringify(redact({ code: 'STORAGE_ERROR', message: 'Cancellation persistence failed' }))}\n`,
          );
        }
      }
      lease.release();
    }
  }
}
