/**
 * @file telemetry.ts — 自定义 Telemetry（遥测）集成
 *
 * @description
 * 本文件实现了 AI SDK v6 的 TelemetryIntegration 接口，
 * 将 LLM 调用的全生命周期事件汇聚到统一日志系统。
 *
 * 在 Cheater 系统中的角色：
 *   遥测是可观测性的核心组件。通过在每次 generateText/streamText 调用中
 *   注入此 TelemetryIntegration，可以追踪：
 *     - 每次 LLM 调用的开始和结束（含总 token 用量）
 *     - 每个推理步骤（step）的开始和结束（含单步 token 用量）
 *     - 工具调用（tool call）的开始和结束（含耗时和成功状态）
 *
 * 事件收集架构：
 *   - 内部维护一个有上限的事件日志数组（最多 1000 条）
 *   - 支持注册外部事件处理器（handler），用于对接日志系统、监控平台
 *   - handler 抛出异常不会影响主流程
 *
 * 支持的事件类型：
 *   - onStart: 生成开始
 *   - onStepStart/Finish: 每步开始/完成（含 token 用量）
 *   - onToolCallStart/Finish: 工具调用追踪（含耗时和成功/失败状态）
 *   - onFinish: 整体完成（含总 token 用量）
 *
 * 用法示例：
 *   ```ts
 *   generateText({
 *     experimental_telemetry: {
 *       isEnabled: true,
 *       functionId: 'design-analyzer',
 *       integrations: [frontendAgentTelemetry()],
 *     },
 *   });
 *   ```
 */

import { bindTelemetryIntegration, type TelemetryIntegration } from 'ai';

// ── 事件类型定义 ──

/**
 * 遥测事件数据结构
 *
 * @description
 * 统一的事件格式，涵盖 LLM 调用生命周期的所有阶段。
 * 不同类型的事件会填充不同的字段。
 */
export interface TelemetryEvent {
  /** 事件类型：start=开始, step-start/finish=步骤, tool-start/finish=工具调用, finish=结束 */
  type: 'start' | 'step-start' | 'step-finish' | 'tool-start' | 'tool-finish' | 'finish';
  /** 事件发生的 Unix 时间戳（毫秒） */
  timestamp: number;
  /** AI SDK 中配置的 functionId，用于标识调用来源（如 'design-analyzer'） */
  functionId?: string;
  /** 使用的模型 ID */
  modelId?: string;
  /** 步骤编号（step-start/step-finish 事件） */
  stepNumber?: number;
  /** 工具名称（tool-start/tool-finish 事件） */
  toolName?: string;
  /** 耗时（毫秒，tool-finish 事件） */
  durationMs?: number;
  /** token 用量统计（step-finish/finish 事件） */
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** 是否成功（tool-finish 事件） */
  success?: boolean;
  /** 错误信息（tool-finish 事件，失败时） */
  error?: unknown;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 遥测事件处理器函数类型 */
export type TelemetryEventHandler = (event: TelemetryEvent) => void;

// ── 事件收集器 ──

/** 事件日志的最大容量，超出后裁剪旧事件 */
const MAX_EVENT_LOG_SIZE = 1000;
/** 全局事件日志数组 */
const eventLog: TelemetryEvent[] = [];
/** 外部注册的事件处理器列表 */
const handlers: TelemetryEventHandler[] = [];

/**
 * 注册外部事件处理器
 *
 * @description
 * 允许外部系统（日志系统、监控平台、分析工具等）订阅遥测事件。
 * 返回一个取消订阅的函数，调用后移除该处理器。
 *
 * @param handler - 事件处理器函数
 * @returns 取消订阅的函数
 */
export function onTelemetryEvent(handler: TelemetryEventHandler): () => void {
  handlers.push(handler);
  // 返回取消订阅函数
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/**
 * 内部事件分发函数
 *
 * @description
 * 将事件追加到日志数组（超限时裁剪旧事件），
 * 并逐一通知所有注册的外部处理器。
 * handler 抛出的异常会被静默捕获，不影响主流程。
 *
 * @param event - 要分发的遥测事件
 */
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

// 以下接口定义了 AI SDK 遥测钩子传入的事件对象结构。
// 由于 AI SDK 未导出这些类型，此处手动定义以确保类型安全。

/** onStart 钩子接收的事件结构 */
interface TelemetryStartEvent {
  functionId?: string;
  model?: { modelId?: string };
}

/** onStepStart 钩子接收的事件结构 */
interface TelemetryStepStartEvent {
  stepNumber?: number;
  model?: { modelId?: string };
}

/** onStepFinish 钩子接收的事件结构 */
interface TelemetryStepFinishEvent {
  stepNumber?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/** onToolCallStart 钩子接收的事件结构 */
interface TelemetryToolCallStartEvent {
  toolCall?: { toolName?: string };
  toolName?: string;
}

/** onToolCallFinish 钩子接收的事件结构 */
interface TelemetryToolCallFinishEvent {
  toolCall?: { toolName?: string };
  toolName?: string;
  durationMs?: number;
  success?: boolean;
  error?: unknown;
}

/** onFinish 钩子接收的事件结构 */
interface TelemetryFinishEvent {
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Frontend Agent 专用遥测集成实现
 *
 * @description
 * 实现 AI SDK 的 TelemetryIntegration 接口的所有钩子方法。
 * 每个钩子将 AI SDK 的原始事件转换为统一的 TelemetryEvent 格式，
 * 通过 emit() 分发给日志系统和外部处理器。
 *
 * 支持 verbose 模式：启用后会将事件详情输出到控制台。
 * 可通过构造参数或 DEBUG_TELEMETRY 环境变量启用。
 */
class FrontendAgentTelemetry implements TelemetryIntegration {
  /** 是否启用详细日志输出 */
  private verbose: boolean;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose ?? process.env.DEBUG_TELEMETRY === 'true';
  }

  /** 生成开始事件 */
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

  /** 步骤开始事件 */
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

  /** 步骤完成事件（含 token 用量） */
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

  /** 工具调用开始事件 */
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

  /** 工具调用完成事件（含耗时和成功/失败状态） */
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

  /** 生成完成事件（含总 token 用量） */
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
 * @description
 * 工厂函数，创建并绑定 FrontendAgentTelemetry 实例。
 * 使用 AI SDK 的 bindTelemetryIntegration 确保正确的生命周期绑定。
 *
 * @param options - 配置选项
 * @param options.verbose - 是否输出详细日志（默认由 DEBUG_TELEMETRY 环境变量控制）
 * @returns 绑定后的 TelemetryIntegration 实例
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

/**
 * 获取所有遥测事件日志
 * @returns 只读的遥测事件数组
 */
export function getTelemetryLog(): readonly TelemetryEvent[] {
  return eventLog;
}

/**
 * 清除所有遥测日志
 *
 * @description
 * 通过设置数组长度为 0 来清空（保持原引用不变）。
 * 在 pipeline 重新开始时调用。
 */
export function resetTelemetryLog(): void {
  eventLog.length = 0;
}

/**
 * 获取按 functionId 分组的遥测统计
 *
 * @description
 * 遍历事件日志，根据 start 事件关联 functionId，
 * 在 finish 事件时汇总调用次数和总 token 用量。
 * 用于分析各 Agent（如 design-analyzer、code-producer）的资源消耗。
 *
 * @returns 以 functionId 为键的统计对象
 */
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

  // 用 currentFunctionId 追踪当前活跃的 functionId，
  // 因为 finish 事件可能不携带 functionId，需要从之前的 start 事件推断
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
