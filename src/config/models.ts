/**
 * @file models.ts — 模型分级与智能路由（v2 — 集成缓存 + Telemetry）
 *
 * 本文件是 Cheater 多模型协作系统的核心枢纽，负责两件事：
 *   1. **路由决策** — 根据任务类型 × 复杂度，自动选择最具性价比的模型等级
 *   2. **中间件包裹** — 为裸模型叠加缓存、成本追踪、输出矫正、prompt 增强等中间件
 *
 * 核心理念：不是让弱模型做强模型的事，而是让每个模型只做擅长的事。
 *
 * 三级模型体系：
 *   executor  →  便宜/快速，做模板化任务（CSS 生成、骨架搭建、需求分类）
 *   worker    →  平衡性价比，做主力工作（通用代码生成、代码审查）
 *   reasoner  →  强推理能力，做复杂决策（架构规划、深度 debug、性能优化）
 *
 * 中间件栈（从外到内，即数组顺序）：
 *   cacheMiddleware → costTrackerMiddleware → outputNormalizerMiddleware → [promptEnhancerMiddleware] → model
 *
 * @module config/models
 */

import { wrapLanguageModel, type LanguageModel } from 'ai'; // Vercel AI SDK 提供的模型包裹工具
import type { AllProviders } from './providers.js'; // 所有 Provider 实例集合
import { outputNormalizerMiddleware } from '../middleware/output-normalizer.js'; // 输出格式矫正中间件
import { promptEnhancerMiddleware } from '../middleware/prompt-enhancer.js'; // executor 专用 prompt 增强中间件
import { costTrackerMiddleware } from '../middleware/cost-tracker.js'; // 成本追踪中间件
import { cacheMiddleware } from '../middleware/cache.js'; // 缓存中间件（最外层，命中即返回）

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/**
 * 模型等级枚举
 *
 * - `executor`  — 廉价快速模型，用于模板化 / 低复杂度任务
 * - `worker`    — 性价比主力模型，用于通用代码生成和审查
 * - `reasoner`  — 高推理能力模型，用于架构决策和深度调试
 */
export type ModelTier = 'executor' | 'worker' | 'reasoner';

/**
 * 任务类型枚举
 *
 * 每种任务类型代表流水线中一个离散的工作单元，
 * 路由表会根据任务类型 × 复杂度映射到对应的模型等级。
 */
export type TaskType =
  | 'classify' // 需求分类 / 路由判断
  | 'component-scaffold' // 组件骨架生成
  | 'css-generation' // 样式代码生成
  | 'code-generation' // 通用代码生成
  | 'code-review' // 代码审查
  | 'design-analysis' // 设计分析
  | 'architecture' // 架构决策
  | 'quality-gate' // 质量门禁判定
  | 'deep-debug'; // 深度 bug 分析

// ══════════════════════════════════════════════════════
//  路由表 — 任务类型 × 复杂度 → 模型等级
// ══════════════════════════════════════════════════════

/**
 * 静态路由表
 *
 * 行：任务类型（TaskType）
 * 列：复杂度（simple / medium / complex）
 * 值：应使用的模型等级（ModelTier）
 *
 * 设计原则：
 *   - 模板化任务（classify、scaffold、css、quality-gate）尽量用 executor 节省成本
 *   - 代码生成类根据复杂度逐级升档：executor → worker → reasoner
 *   - 架构和深度调试类任务默认使用 reasoner，确保推理质量
 */
const ROUTING_TABLE: Record<TaskType, Record<'simple' | 'medium' | 'complex', ModelTier>> = {
  classify: { simple: 'executor', medium: 'executor', complex: 'worker' },
  'component-scaffold': { simple: 'executor', medium: 'executor', complex: 'worker' },
  'css-generation': { simple: 'executor', medium: 'executor', complex: 'worker' },
  'code-generation': { simple: 'executor', medium: 'worker', complex: 'reasoner' },
  'code-review': { simple: 'worker', medium: 'worker', complex: 'reasoner' },
  'design-analysis': { simple: 'executor', medium: 'worker', complex: 'reasoner' },
  architecture: { simple: 'worker', medium: 'reasoner', complex: 'reasoner' },
  'quality-gate': { simple: 'executor', medium: 'executor', complex: 'worker' },
  'deep-debug': { simple: 'worker', medium: 'reasoner', complex: 'reasoner' },
};

// ══════════════════════════════════════════════════════
//  对外 API
// ══════════════════════════════════════════════════════

/**
 * 根据任务类型和复杂度自动选择最佳模型等级
 *
 * 路由策略由 ROUTING_TABLE 静态定义，查找失败时安全回退到 'worker'。
 *
 * @param task       - 任务类型，如 'code-generation'、'architecture'
 * @param complexity - 任务复杂度，默认 'medium'
 * @returns 推荐使用的模型等级（executor / worker / reasoner）
 *
 * @example
 * ```ts
 * const tier = routeModel('code-generation', 'complex'); // → 'reasoner'
 * const tier2 = routeModel('css-generation');              // → 'executor'（medium 默认）
 * ```
 */
export function routeModel(
  task: TaskType,
  complexity: 'simple' | 'medium' | 'complex' = 'medium',
): ModelTier {
  return ROUTING_TABLE[task]?.[complexity] ?? 'worker'; // 未命中时安全回退到 worker
}

/**
 * 获取包裹了中间件的模型实例（核心工厂方法）
 *
 * 这是上层调用 LLM 的唯一入口：传入目标等级和 Provider 集合，
 * 返回一个已叠加完整中间件栈的 LanguageModel 实例，可直接传入
 * Vercel AI SDK 的 generateText() / streamText() 等方法。
 *
 * 中间件执行顺序（数组中越靠前越外层）：
 *   1. cacheMiddleware           — 缓存层（最外层，命中直接返回，不消耗后续中间件）
 *   2. costTrackerMiddleware     — 成本追踪（记录 token 用量和费用）
 *   3. outputNormalizerMiddleware — 输出格式矫正（统一 JSON 结构等）
 *   4. promptEnhancerMiddleware  — executor 专用 prompt 增强（仅弱模型叠加）
 *
 * @param tier       - 目标模型等级（executor / worker / reasoner）
 * @param providers  - 已初始化的 Provider 集合（由 createProviders() 创建）
 * @param options    - 额外选项
 * @param options.noCache - 是否禁用缓存（某些需要输出多样性的场景，如创意生成）
 * @returns 可直接传入 generateText / streamText 的 LanguageModel 实例
 *
 * @example
 * ```ts
 * const providers = createProviders();
 * const model = getWrappedModel('worker', providers);
 * const result = await generateText({ model, prompt: '...' });
 * ```
 */
export function getWrappedModel(
  tier: ModelTier,
  providers: AllProviders,
  options: {
    /** 是否禁用缓存（某些需要多样性的场景） */
    noCache?: boolean;
  } = {},
): LanguageModel {
  const { provider, modelName } = providers[tier]; // 从对应等级取出 Provider 和模型名
  const { noCache = false } = options;

  // 按优先级组装中间件栈（数组越前 = 越外层 = 越先执行）
  const middlewareStack = [];

  // 缓存层放最外面 — 命中后直接返回结果，跳过所有后续中间件，节省开销
  if (!noCache) {
    middlewareStack.push(cacheMiddleware);
  }

  // 所有等级都需要成本追踪和输出矫正
  middlewareStack.push(
    costTrackerMiddleware, // 记录每次调用的 token 消耗和费用
    outputNormalizerMiddleware, // 统一输出格式，如去除 markdown 包裹等
  );

  // 弱模型（executor）额外叠加 prompt 增强，弥补推理能力不足
  if (tier === 'executor') {
    middlewareStack.push(promptEnhancerMiddleware);
  }

  // 使用 Vercel AI SDK 的 wrapLanguageModel 组装最终模型
  return wrapLanguageModel({
    // 使用 provider.chat() 走 /chat/completions 端点（兼容所有 OpenAI API 兼容服务）
    // provider() 默认走 /responses 端点（仅 OpenAI 原生支持，第三方不兼容）
    model: provider.chat(modelName),
    middleware: middlewareStack,
  });
}
