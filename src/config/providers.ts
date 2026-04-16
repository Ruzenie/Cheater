/**
 * providers.ts — Provider 统一初始化
 *
 * 支持三种模式：
 *   1. 每个 Tier 独立配置（EXECUTOR_*, WORKER_*, REASONER_*）
 *   2. 统一配置（LLM_API_KEY + LLM_BASE_URL），各 Tier 仅区分模型名
 *   3. 混合模式（部分独立 + 部分回退到统一配置）
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { OpenAIProvider } from '@ai-sdk/openai';

export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  modelName: string;
}

export interface AllProviders {
  executor: { provider: OpenAIProvider; modelName: string };
  worker: { provider: OpenAIProvider; modelName: string };
  reasoner: { provider: OpenAIProvider; modelName: string };
}

/**
 * 从环境变量中读取某个 Tier 的配置，支持回退到统一变量
 */
function loadTierConfig(tier: 'EXECUTOR' | 'WORKER' | 'REASONER'): ProviderConfig {
  const apiKey = process.env[`${tier}_API_KEY`] ?? process.env.LLM_API_KEY;

  const baseURL = process.env[`${tier}_BASE_URL`] ?? process.env.LLM_BASE_URL;

  const modelName = process.env[`${tier}_MODEL`] ?? process.env.LLM_MODEL;

  if (!apiKey || !baseURL || !modelName) {
    throw new Error(
      `[providers] 缺少 ${tier} 配置。` +
        `请设置 ${tier}_API_KEY / ${tier}_BASE_URL / ${tier}_MODEL，` +
        `或设置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 作为回退。`,
    );
  }

  return { apiKey, baseURL, modelName };
}

/**
 * 初始化所有 Provider 实例
 */
export function createProviders(): AllProviders {
  const tiers = ['EXECUTOR', 'WORKER', 'REASONER'] as const;
  const result = {} as AllProviders;

  for (const tier of tiers) {
    const config = loadTierConfig(tier);
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    const key = tier.toLowerCase() as keyof AllProviders;
    result[key] = { provider, modelName: config.modelName };
  }

  return result;
}
