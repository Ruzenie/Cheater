/**
 * telemetry.ts — 自定义 Telemetry 集成
 *
 * 实现 AI SDK v6 的 TelemetryIntegration 接口，
 * 将 LLM 调用的全生命周期事件汇聚到统一日志。
 *
 * 支持：
 *   - onStart: 生成开始
 *   - onStepStart/Finish: 每步开始/完成（含 token 用量）
 *   - onToolCallStart/Finish: 工具调用追踪（含耗时）
 *   - onFinish: 整体完成（含总 token 用量）
 *
 * 用法：
 *   generateText({
 *     experimental_telemetry: {
 *       isEnabled: true,
 *       functionId: 'design-analyzer',
 *       integrations: [frontendAgentTelemetry()],
 *     },
 *   });
 */

import { bindTelemetryIntegration, type TelemetryIntegration } from 'ai';

// ── 事件类型 ──

export interface TelemetryEvent {
  type: 'start' | 'step-start' | 'step-finish' | 'tool-start' | 'tool-finish' | 'finish';
  timestamp: number;
  functionId?: string;
  modelId?: string;
  stepNumber?: number;
  toolName?: string;
  durationMs?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  success?: boolean;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export type TelemetryEventHandler = (event: TelemetryEvent) => void;

// ── 事件收集器 ──

const MAX_EVENT_LOG_SIZE = 1000;
const eventLog: TelemetryEvent[] = [];
const handlers: TelemetryEventHandler[] = [];

/** 注册外部事件处理器（日志系统、监控平台等） */
export function onTelemetryEvent(handler: TelemetryEventHandler): () => void {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

function emit(event: TelemetryEvent): void {
  eventLog.push(event);
  if (eventLog.length > MAX_EVENT_LOG_SIZE) {
    eventLog.splice(0, eventLog.length - MAX_EVENT_LOG_SIZE);
  }
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // 不因 handler 错误影响主流程
    }
  }
}

// ── TelemetryIntegration 实现 ──

/** Shape of events received from AI SDK telemetry hooks */
interface TelemetryStartEvent {
  functionId?: string;
  model?: { modelId?: string };
}

interface TelemetryStepStartEvent {
  stepNumber?: number;
  model?: { modelId?: string };
}

interface TelemetryStepFinishEvent {
  stepNumber?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface TelemetryToolCallStartEvent {
  toolCall?: { toolName?: string };
  toolName?: string;
}

interface TelemetryToolCallFinishEvent {
  toolCall?: { toolName?: string };
  toolName?: string;
  durationMs?: number;
  success?: boolean;
  error?: unknown;
}

interface TelemetryFinishEvent {
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

class FrontendAgentTelemetry implements TelemetryIntegration {
  private verbose: boolean;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose ?? process.env.DEBUG_TELEMETRY === 'true';
  }

  async onStart(event: TelemetryStartEvent): Promise<void> {
    const telemetryEvent: TelemetryEvent = {
      type: 'start',
      timestamp: Date.now(),
      functionId: event.functionId,
      modelId: event.model?.modelId,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      console.log(
        `[telemetry] 🚀 start | model: ${event.model?.modelId} | fn: ${event.functionId ?? 'unknown'}`,
      );
    }
  }

  async onStepStart(event: TelemetryStepStartEvent): Promise<void> {
    const telemetryEvent: TelemetryEvent = {
      type: 'step-start',
      timestamp: Date.now(),
      stepNumber: event.stepNumber,
      modelId: event.model?.modelId,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      console.log(
        `[telemetry]   📍 step ${event.stepNumber} start | model: ${event.model?.modelId}`,
      );
    }
  }

  async onStepFinish(event: TelemetryStepFinishEvent): Promise<void> {
    const usage = event.usage;
    const telemetryEvent: TelemetryEvent = {
      type: 'step-finish',
      timestamp: Date.now(),
      stepNumber: event.stepNumber,
      tokenUsage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      const tokens = usage
        ? `${usage.inputTokens ?? '?'}+${usage.outputTokens ?? '?'} tokens`
        : 'unknown tokens';
      console.log(`[telemetry]   ✅ step ${event.stepNumber} finish | ${tokens}`);
    }
  }

  async onToolCallStart(event: TelemetryToolCallStartEvent): Promise<void> {
    const telemetryEvent: TelemetryEvent = {
      type: 'tool-start',
      timestamp: Date.now(),
      toolName: event.toolCall?.toolName ?? event.toolName,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      console.log(`[telemetry]     🔧 tool start: ${event.toolCall?.toolName ?? event.toolName}`);
    }
  }

  async onToolCallFinish(event: TelemetryToolCallFinishEvent): Promise<void> {
    const telemetryEvent: TelemetryEvent = {
      type: 'tool-finish',
      timestamp: Date.now(),
      toolName: event.toolCall?.toolName ?? event.toolName,
      durationMs: event.durationMs,
      success: event.success ?? !event.error,
      error: event.error,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      const status = event.success !== false ? '✅' : '❌';
      console.log(
        `[telemetry]     ${status} tool finish: ${event.toolCall?.toolName ?? event.toolName} (${event.durationMs ?? '?'}ms)`,
      );
    }
  }

  async onFinish(event: TelemetryFinishEvent): Promise<void> {
    const totalUsage = event.totalUsage;
    const telemetryEvent: TelemetryEvent = {
      type: 'finish',
      timestamp: Date.now(),
      tokenUsage: totalUsage
        ? {
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            totalTokens: totalUsage.totalTokens,
          }
        : undefined,
    };
    emit(telemetryEvent);

    if (this.verbose) {
      const tokens = totalUsage
        ? `total: ${totalUsage.totalTokens ?? '?'} tokens`
        : 'unknown total';
      console.log(`[telemetry] 🏁 finish | ${tokens}`);
    }
  }
}

/**
 * 创建 Frontend Agent 专用的 Telemetry 集成
 *
 * @example
 * ```ts
 * const result = await generateText({
 *   model,
 *   prompt: '...',
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     functionId: 'design-analyzer',
 *     integrations: [frontendAgentTelemetry()],
 *   },
 * });
 * ```
 */
export function frontendAgentTelemetry(options: { verbose?: boolean } = {}): TelemetryIntegration {
  return bindTelemetryIntegration(new FrontendAgentTelemetry(options));
}

// ── 查询 API ──

/** 获取所有 telemetry 事件日志 */
export function getTelemetryLog(): readonly TelemetryEvent[] {
  return eventLog;
}

/** 清除 telemetry 日志 */
export function resetTelemetryLog(): void {
  eventLog.length = 0;
}

/** 获取按 functionId 分组的统计 */
export function getTelemetryStats(): Record<
  string,
  {
    calls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }
> {
  const stats: Record<
    string,
    {
      calls: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }
  > = {};

  let currentFunctionId = 'unknown';

  for (const event of eventLog) {
    if (event.type === 'start' && event.functionId) {
      currentFunctionId = event.functionId;
    }
    if (event.type === 'finish') {
      const key = event.functionId ?? currentFunctionId;
      if (!stats[key]) {
        stats[key] = { calls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
      }
      stats[key].calls++;
      stats[key].totalInputTokens += event.tokenUsage?.inputTokens ?? 0;
      stats[key].totalOutputTokens += event.tokenUsage?.outputTokens ?? 0;
    }
  }

  return stats;
}
