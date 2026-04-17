/**
 * @file providers.ts — Provider 统一初始化
 *
 * 本文件负责为 Cheater 的三级模型体系（executor / worker / reasoner）
 * 各自创建 OpenAI 兼容的 Provider 实例。
 *
 * 架构角色：
 *   - 是整个 LLM 调用链的最底层：Provider 实例由此处创建，
 *     之后交给 models.ts 的 getWrappedModel() 包裹中间件。
 *   - 所有 Provider 使用 @ai-sdk/openai 的 createOpenAI()，
 *     因此兼容任何 OpenAI API 格式的服务（如 Azure、DeepSeek、Moonshot 等）。
 *
 * 配置优先级（支持三种模式）：
 *   1. 独立配置 — 每个 Tier 使用专属环境变量（EXECUTOR_API_KEY, EXECUTOR_BASE_URL, EXECUTOR_MODEL）
 *   2. 统一配置 — 所有 Tier 共享通用变量（LLM_API_KEY, LLM_BASE_URL, LLM_MODEL）
 *   3. 混合模式 — 部分 Tier 独立配置，其余回退到统一变量
 *
 * @module config/providers
 */

import { createOpenAI } from '@ai-sdk/openai'; // Vercel AI SDK 的 OpenAI Provider 工厂函数
import type { OpenAIProvider } from '@ai-sdk/openai'; // OpenAI Provider 类型

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/**
 * 单个 Tier 的 Provider 配置
 *
 * 从环境变量中解析得到，包含连接 LLM 服务所需的全部信息。
 */
export interface ProviderConfig {
  /** API 密钥（用于鉴权） */
  apiKey: string;
  /** API 基础 URL（如 https://api.openai.com/v1） */
  baseURL: string;
  /** 模型名称（如 gpt-4o-mini、deepseek-chat） */
  modelName: string;
}

/**
 * 所有 Tier 的 Provider 实例集合
 *
 * 每个 Tier 包含一个已初始化的 OpenAIProvider 和对应的模型名称。
 * 由 createProviders() 统一创建后，传递给 getWrappedModel() 使用。
 */
export interface AllProviders {
  /** 执行器级 — 廉价快速模型 */
  executor: { provider: OpenAIProvider; modelName: string };
  /** 工人级 — 性价比主力模型 */
  worker: { provider: OpenAIProvider; modelName: string };
  /** 推理器级 — 强推理能力模型 */
  reasoner: { provider: OpenAIProvider; modelName: string };
}

// ══════════════════════════════════════════════════════
//  内部辅助函数
// ══════════════════════════════════════════════════════

/**
 * 从环境变量中读取指定 Tier 的配置
 *
 * 查找策略：先尝试 Tier 专属变量（如 EXECUTOR_API_KEY），
 * 若不存在则回退到通用变量（如 LLM_API_KEY）。
 * 三个必需字段（apiKey / baseURL / modelName）任一缺失则抛出明确错误。
 *
 * @param tier - 大写 Tier 名称：'EXECUTOR' | 'WORKER' | 'REASONER'
 * @returns 解析后的 ProviderConfig
 * @throws 缺少必需环境变量时抛出错误，附带修复指引
 */
function loadTierConfig(tier: 'EXECUTOR' | 'WORKER' | 'REASONER'): ProviderConfig {
  // 优先读取 Tier 专属变量，回退到通用变量
  const apiKey = process.env[`${tier}_API_KEY`] ?? process.env.LLM_API_KEY;

  const baseURL = process.env[`${tier}_BASE_URL`] ?? process.env.LLM_BASE_URL;

  const modelName = process.env[`${tier}_MODEL`] ?? process.env.LLM_MODEL;

  // 任一缺失则无法初始化，抛出包含修复指引的错误
  if (!apiKey || !baseURL || !modelName) {
    throw new Error(
      `[providers] 缺少 ${tier} 配置。` +
        `请设置 ${tier}_API_KEY / ${tier}_BASE_URL / ${tier}_MODEL，` +
        `或设置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 作为回退。`,
    );
  }

  return { apiKey, baseURL, modelName };
}

// ══════════════════════════════════════════════════════
//  对外 API
// ══════════════════════════════════════════════════════

/**
 * 初始化所有 Tier 的 Provider 实例
 *
 * 遍历三个 Tier（executor / worker / reasoner），依次：
 *   1. 从环境变量加载配置（loadTierConfig）
 *   2. 使用 createOpenAI() 创建兼容 OpenAI API 的 Provider
 *   3. 将 Provider 和模型名打包存入结果对象
 *
 * @returns 包含三个 Tier 的 AllProviders 实例，可传给 getWrappedModel() 使用
 * @throws 任一 Tier 缺少必需环境变量时抛出错误
 *
 * @example
 * ```ts
 * const providers = createProviders();
 * const model = getWrappedModel('worker', providers);
 * ```
 */
export function createProviders(): AllProviders {
  const tiers = ['EXECUTOR', 'WORKER', 'REASONER'] as const;
  const result = {} as AllProviders;

  for (const tier of tiers) {
    const config = loadTierConfig(tier);
    // 使用 @ai-sdk/openai 创建 Provider（兼容所有 OpenAI API 格式服务）
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    // 将大写 Tier 名转为小写作为对象键（EXECUTOR → executor）
    const key = tier.toLowerCase() as keyof AllProviders;
    result[key] = { provider, modelName: config.modelName };
  }

  return result;
}
