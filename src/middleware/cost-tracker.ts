/**
 * @file cost-tracker.ts — 成本追踪中间件
 *
 * @description
 * 本文件实现了 LLM 调用的 token 消耗与成本追踪中间件。
 * 它以 AI SDK v6 LanguageModelV3Middleware 的形式，透明地包裹每次
 * generateText / streamText 调用，在调用完成后记录 token 用量并估算美元成本。
 *
 * 在 Cheater 系统中的角色：
 *   多模型管线中每个步骤（Prompt 精炼、设计分析、代码生产、审计等）
 *   都会发起 LLM 调用。成本追踪中间件作为"观察者"，不修改请求/响应，
 *   只被动记录每次调用的 token 用量和耗时，用于：
 *     - 实时监控单次 pipeline 的总成本，确保不超出预算
 *     - 评估模型路由策略是否合理（贵模型是否被过度使用）
 *     - 发现成本异常（某步骤 token 用量暴涨可能意味着 Prompt 膨胀）
 *
 * 技术细节：
 *   - wrapGenerate: 记录非流式调用的 token 用量和耗时
 *   - wrapStream: 通过 TransformStream 拦截流式 chunk，
 *     从 usage/finish/step-finish 类型的 chunk 中提取 token 信息
 *   - 支持多种 token 用量格式（number 或 { total: number }）
 *   - 全局记录数组有 500 条上限，防止内存泄漏
 *   - 内置粗略定价表，支持 doubao-lite、deepseek-chat、deepseek-reasoner
 */

import type { LanguageModelMiddleware } from 'ai';

// ── 成本记录 ──────────────────────────────────────────

/**
 * 单次 LLM 调用的成本记录
 *
 * @description
 * 每次 LLM 调用（无论是 generateText 还是 streamText）完成后，
 * 都会生成一条 CostRecord 并追加到全局记录数组中。
 */
export interface CostRecord {
  /** 调用开始的 Unix 时间戳（毫秒） */
  timestamp: number;
  /** 使用的模型标识符 */
  modelId: string;
  /** 输入（Prompt）消耗的 token 数量 */
  inputTokens: number;
  /** 输出（生成）消耗的 token 数量 */
  outputTokens: number;
  /** 估算的美元成本（基于内置定价表） */
  estimatedCost: number; // 单位：美元
  /** 调用耗时（毫秒） */
  durationMs: number;
}

// ── 全局记录存储 ──

/** 记录数组的硬上限，防止长时间运行导致内存泄漏 */
const MAX_COST_RECORDS = 500;
/** 全局成本记录数组（每次 pipeline 运行后可通过 resetCostRecords 清理） */
const records: CostRecord[] = [];

/**
 * 模型定价表（每 1M token 的美元价格）
 *
 * @description
 * 粗略定价，用于估算成本。未匹配到的模型使用 default 定价。
 * 可根据实际使用的模型和最新价格调整此表。
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'doubao-lite': { input: 0.3, output: 0.6 },
  'deepseek-chat': { input: 1.0, output: 2.0 },
  'deepseek-reasoner': { input: 4.0, output: 16.0 },
  // 默认定价（未知模型）
  default: { input: 2.0, output: 6.0 },
};

/**
 * 根据模型 ID 和 token 数量估算美元成本
 *
 * @description
 * 从 modelId 中模糊匹配定价表中的键名（使用 includes），
 * 未匹配到则使用 default 定价。
 *
 * @param modelId - 模型标识符（如 "doubao-lite-32k"）
 * @param inputTokens - 输入 token 数量
 * @param outputTokens - 输出 token 数量
 * @returns 估算的美元成本
 */
function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  // 从 modelId 中提取可识别的模型名（模糊匹配）
  const key = Object.keys(PRICING).find((k) => modelId.includes(k)) ?? 'default';
  const price = PRICING[key];
  // 按每百万 token 的单价计算
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ── 中间件实现 ────────────────────────────────────────────

/**
 * 成本追踪中间件
 *
 * @description
 * 遵循 AI SDK v6 LanguageModelV3Middleware 规范。
 * 同时支持 generateText（wrapGenerate）和 streamText（wrapStream）两种调用方式。
 * 不修改请求和响应，仅在调用完成后被动记录成本数据。
 */
export const costTrackerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  /**
   * 包裹非流式 generateText 调用
   * 在调用完成后提取 usage 信息并记录成本
   */
  wrapGenerate: async ({ doGenerate, model }) => {
    const start = Date.now();
    const result = await doGenerate();
    const duration = Date.now() - start;

    // 兼容不同 Provider 的 token 用量格式：
    // 有些 Provider 返回 number，有些返回 { total: number }
    const inputTokens =
      typeof result.usage?.inputTokens === 'number'
        ? result.usage.inputTokens
        : ((result.usage?.inputTokens as { total?: number } | undefined)?.total ?? 0);
    const outputTokens =
      typeof result.usage?.outputTokens === 'number'
        ? result.usage.outputTokens
        : ((result.usage?.outputTokens as { total?: number } | undefined)?.total ?? 0);
    const modelId = model.modelId ?? 'unknown';

    const record: CostRecord = {
      timestamp: start,
      modelId,
      inputTokens,
      outputTokens,
      estimatedCost: estimateCost(modelId, inputTokens, outputTokens),
      durationMs: duration,
    };

    // 追加记录，超过上限时裁剪旧记录
    records.push(record);
    if (records.length > MAX_COST_RECORDS) {
      records.splice(0, records.length - MAX_COST_RECORDS);
    }

    // 调试模式下输出成本日志
    if (process.env.DEBUG_COST === 'true') {
      console.log(
        `[cost] ${record.modelId} | ${inputTokens}+${outputTokens} tokens | ` +
          `$${record.estimatedCost.toFixed(6)} | ${duration}ms`,
      );
    }

    return result;
  },

  /**
   * 包裹流式 streamText 调用
   *
   * @description
   * 流式调用无法在调用结束时直接获取 token 用量。
   * 通过 TransformStream 拦截流中的 chunk，从特定类型的 chunk
   * （usage、finish、step-finish）中提取 token 信息。
   * 在流结束时（flush 回调）记录最终的成本数据。
   */
  wrapStream: async ({ doStream, model }) => {
    const start = Date.now();
    const { stream, ...rest } = await doStream();
    const modelId = model.modelId ?? 'unknown';

    // 通过 TransformStream 拦截流，在完成时记录 usage
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    /** 流式 chunk 的可能结构（用于类型安全地提取 usage 信息） */
    interface StreamChunkLike {
      type?: string;
      inputTokens?: number | { total?: number };
      outputTokens?: number | { total?: number };
      usage?: {
        inputTokens?: number | { total?: number };
        outputTokens?: number | { total?: number };
      };
      experimental_providerMetadata?: {
        usage?: {
          inputTokens?: number | { total?: number };
          outputTokens?: number | { total?: number };
        };
      };
    }

    // 创建 TransformStream 拦截流中的 chunk，提取 token 用量
    const trackingStream = new TransformStream({
      /**
       * 每个 chunk 流过时检查是否包含 usage 信息。
       * 支持三种 chunk 格式：type=usage、type=finish、type=step-finish。
       * 同时兼容 experimental_providerMetadata 中的 usage 字段。
       */
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        const c = chunk as StreamChunkLike;
        // 捕获各种可能包含 usage 信息的 chunk 格式
        if (c.type === 'usage') {
          totalInputTokens =
            typeof c.inputTokens === 'number'
              ? c.inputTokens
              : ((c.inputTokens as { total?: number } | undefined)?.total ?? totalInputTokens);
          totalOutputTokens =
            typeof c.outputTokens === 'number'
              ? c.outputTokens
              : ((c.outputTokens as { total?: number } | undefined)?.total ?? totalOutputTokens);
        }
        if (c.type === 'finish' || c.type === 'step-finish') {
          const usage = c.usage ?? c.experimental_providerMetadata?.usage;
          if (usage) {
            totalInputTokens =
              typeof usage.inputTokens === 'number'
                ? usage.inputTokens
                : ((usage.inputTokens as { total?: number } | undefined)?.total ?? totalInputTokens);
            totalOutputTokens =
              typeof usage.outputTokens === 'number'
                ? usage.outputTokens
                : ((usage.outputTokens as { total?: number } | undefined)?.total ?? totalOutputTokens);
          }
        }
        controller.enqueue(chunk);
      },
      /**
       * 流结束时的回调，此时已收集到完整的 token 用量。
       * 计算成本并将记录追加到全局记录数组。
       */
      flush() {
        const duration = Date.now() - start;
        const inputTokens = totalInputTokens;
        const outputTokens = totalOutputTokens;

        const record: CostRecord = {
          timestamp: start,
          modelId,
          inputTokens,
          outputTokens,
          estimatedCost: estimateCost(modelId, inputTokens, outputTokens),
          durationMs: duration,
        };

        records.push(record);
        if (records.length > MAX_COST_RECORDS) {
          records.splice(0, records.length - MAX_COST_RECORDS);
        }

        if (process.env.DEBUG_COST === 'true') {
          console.log(
            `[cost:stream] ${record.modelId} | ${inputTokens}+${outputTokens} tokens | ` +
              `$${record.estimatedCost.toFixed(6)} | ${duration}ms`,
          );
        }
      },
    });

    // 将原始流通过追踪 TransformStream 管道化，实现无侵入式拦截
    return {
      stream: stream.pipeThrough(trackingStream),
      ...rest,
    };
  },
};

// ── 对外查询 API ──────────────────────────────────────

/**
 * 获取所有成本记录
 * @returns 只读的成本记录数组
 */
export function getCostRecords(): readonly CostRecord[] {
  return records;
}

/**
 * 获取所有记录的累计总成本
 * @returns 总成本（美元）
 */
export function getTotalCost(): number {
  return records.reduce((sum, r) => sum + r.estimatedCost, 0);
}

/**
 * 按模型分组统计成本
 *
 * @description
 * 将所有成本记录按 modelId 分组，汇总每个模型的调用次数、总成本和总 token 数。
 * 用于评估不同模型的使用比例和成本分布。
 *
 * @returns 以模型 ID 为键的统计对象
 */
export function getCostByModel(): Record<string, { calls: number; cost: number; tokens: number }> {
  const grouped: Record<string, { calls: number; cost: number; tokens: number }> = {};
  for (const r of records) {
    const key = r.modelId;
    if (!grouped[key]) grouped[key] = { calls: 0, cost: 0, tokens: 0 };
    grouped[key].calls++;
    grouped[key].cost += r.estimatedCost;
    grouped[key].tokens += r.inputTokens + r.outputTokens;
  }
  return grouped;
}

/**
 * 打印格式化的成本报告到控制台
 *
 * @description
 * 输出带有 Unicode 表格框的成本报告，包含：
 *   - 每个模型的调用次数、token 用量和估算成本
 *   - 所有模型的累计总成本
 * 适合在 pipeline 结束后调用，便于快速查看本次运行的花费。
 */
export function printCostReport(): void {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║          💰 成本追踪报告                 ║');
  console.log('╠══════════════════════════════════════════╣');

  const byModel = getCostByModel();
  for (const [model, stats] of Object.entries(byModel)) {
    console.log(`║  ${model.padEnd(22)} ${stats.calls} 次调用`);
    console.log(
      `║    tokens: ${stats.tokens.toLocaleString().padStart(10)}  cost: $${stats.cost.toFixed(6)}`,
    );
  }

  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  总计: $${getTotalCost().toFixed(6).padStart(12)}                    ║`);
  console.log('╚══════════════════════════════════════════╝\n');
}

/**
 * 清除所有成本记录
 *
 * @description
 * 在 pipeline 重新开始时调用，避免上一次运行的记录污染本次统计。
 * 通过设置数组长度为 0 来清空（保持原引用不变）。
 */
export function resetCostRecords(): void {
  records.length = 0;
}
