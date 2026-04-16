/**
 * cost-tracker.ts — 成本追踪中间件
 *
 * 记录每次 LLM 调用的 token 消耗，用于：
 *   - 实时监控单次 pipeline 总成本
 *   - 评估模型路由策略是否合理
 *   - 发现成本异常（某步骤 token 用量暴涨）
 */

import type { LanguageModelMiddleware } from 'ai';

// ── 成本记录 ──────────────────────────────────────────

export interface CostRecord {
  timestamp: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number; // 单位：美元
  durationMs: number;
}

// 全局记录（每次 pipeline 运行后可清理）
const MAX_COST_RECORDS = 500;
const records: CostRecord[] = [];

// 粗略定价（每 1M token），可根据实际情况调整
const PRICING: Record<string, { input: number; output: number }> = {
  'doubao-lite': { input: 0.3, output: 0.6 },
  'deepseek-chat': { input: 1.0, output: 2.0 },
  'deepseek-reasoner': { input: 4.0, output: 16.0 },
  // 默认定价（未知模型）
  default: { input: 2.0, output: 6.0 },
};

function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  // 从 modelId 中提取可识别的模型名
  const key = Object.keys(PRICING).find((k) => modelId.includes(k)) ?? 'default';
  const price = PRICING[key];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ── 中间件 ────────────────────────────────────────────

export const costTrackerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  wrapGenerate: async ({ doGenerate, model }) => {
    const start = Date.now();
    const result = await doGenerate();
    const duration = Date.now() - start;

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

    records.push(record);
    if (records.length > MAX_COST_RECORDS) {
      records.splice(0, records.length - MAX_COST_RECORDS);
    }

    if (process.env.DEBUG_COST === 'true') {
      console.log(
        `[cost] ${record.modelId} | ${inputTokens}+${outputTokens} tokens | ` +
          `$${record.estimatedCost.toFixed(6)} | ${duration}ms`,
      );
    }

    return result;
  },

  wrapStream: async ({ doStream, model }) => {
    const start = Date.now();
    const { stream, ...rest } = await doStream();
    const modelId = model.modelId ?? 'unknown';

    // 通过 TransformStream 拦截流，在完成时记录 usage
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    /** Shape of a stream chunk that may carry usage or finish info */
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

    const trackingStream = new TransformStream({
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

    return {
      stream: stream.pipeThrough(trackingStream),
      ...rest,
    };
  },
};

// ── 对外查询 API ──────────────────────────────────────

/** 获取所有记录 */
export function getCostRecords(): readonly CostRecord[] {
  return records;
}

/** 获取总成本 */
export function getTotalCost(): number {
  return records.reduce((sum, r) => sum + r.estimatedCost, 0);
}

/** 按模型分组统计 */
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

/** 打印成本报告 */
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

/** 清除记录（pipeline 重新开始时调用） */
export function resetCostRecords(): void {
  records.length = 0;
}
