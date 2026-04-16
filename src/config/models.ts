/**
 * models.ts — 模型分级与智能路由（v2 — 集成缓存 + Telemetry）
 *
 * 核心理念：不是让弱模型做强模型的事，而是让每个模型只做擅长的事。
 *
 *   executor  →  便宜/快速，做模板化任务（CSS、骨架、分类）
 *   worker    →  平衡性价比，做主力工作（代码生成、一般审查）
 *   reasoner  →  强推理，做复杂决策（架构规划、深度 debug）
 *
 * 中间件栈（从外到内）：
 *   cache → costTracker → outputNormalizer → [promptEnhancer] → model
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { AllProviders } from './providers.js';
import { outputNormalizerMiddleware } from '../middleware/output-normalizer.js';
import { promptEnhancerMiddleware } from '../middleware/prompt-enhancer.js';
import { costTrackerMiddleware } from '../middleware/cost-tracker.js';
import { cacheMiddleware } from '../middleware/cache.js';

// ── 类型 ──────────────────────────────────────────────

export type ModelTier = 'executor' | 'worker' | 'reasoner';

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

// ── 路由表 ────────────────────────────────────────────

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

// ── 对外 API ──────────────────────────────────────────

/**
 * 根据任务类型和复杂度自动选择模型等级
 */
export function routeModel(
  task: TaskType,
  complexity: 'simple' | 'medium' | 'complex' = 'medium',
): ModelTier {
  return ROUTING_TABLE[task]?.[complexity] ?? 'worker';
}

/**
 * 获取包裹了中间件的模型实例（核心工厂方法）
 *
 * 中间件执行顺序（数组中越靠前越外层）：
 *   1. cacheMiddleware       — 缓存层（最外层，命中直接返回）
 *   2. costTrackerMiddleware — 成本追踪
 *   3. outputNormalizerMiddleware — 输出格式矫正
 *   4. promptEnhancerMiddleware  — executor 专用 prompt 增强
 *
 * @param tier       目标等级
 * @param providers  已初始化的 Provider 集合
 * @param options    额外选项
 * @returns          可直接传入 generateText / streamText 的 model 对象
 */
export function getWrappedModel(
  tier: ModelTier,
  providers: AllProviders,
  options: {
    /** 是否禁用缓存（某些需要多样性的场景） */
    noCache?: boolean;
  } = {},
): LanguageModel {
  const { provider, modelName } = providers[tier];
  const { noCache = false } = options;

  // 不同等级叠加不同中间件
  const middlewareStack = [];

  // 缓存层放最外面 — 命中直接返回，不消耗后续中间件
  if (!noCache) {
    middlewareStack.push(cacheMiddleware);
  }

  middlewareStack.push(
    costTrackerMiddleware, // 所有等级：追踪成本
    outputNormalizerMiddleware, // 所有等级：输出格式矫正
  );

  // 弱模型额外叠加 prompt 增强
  if (tier === 'executor') {
    middlewareStack.push(promptEnhancerMiddleware);
  }

  return wrapLanguageModel({
    // 使用 provider.chat() 走 /chat/completions 端点
    // provider() 默认走 /responses 端点（仅 OpenAI 原生支持）
    model: provider.chat(modelName),
    middleware: middlewareStack,
  });
}
