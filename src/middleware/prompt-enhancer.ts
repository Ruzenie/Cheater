/**
 * prompt-enhancer.ts — Prompt 增强中间件
 *
 * 专为弱模型设计：在 system prompt 末尾追加结构化约束规则，
 * 提高输出质量和格式一致性。
 *
 * 只在 executor (Tier 1) 模型上启用。
 */

import type { LanguageModelMiddleware } from 'ai';

const ENHANCEMENT_RULES = `

[结构化输出约束]
- 如果被要求输出 JSON，直接输出合法 JSON，不要用 markdown 包裹
- 对象的每个字段都必须有值，不允许 undefined 或空字符串
- 数组至少包含一个元素，除非语义上确实为空
- 如果不确定答案，给出你最有把握的保守实现
- 保持简洁，不要输出解释性文字，直接给结果

[代码输出约束]
- 使用 TypeScript 严格模式
- 变量和函数使用 camelCase 命名
- 组件使用 PascalCase 命名
- 每个函数不超过 30 行
- 必须处理 null / undefined 边界情况`;

export const promptEnhancerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  transformParams: async ({ params }) => {
    // 找到 system 消息并追加规则
    const enhancedPrompt = params.prompt.map((msg) => {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        return { ...msg, content: msg.content + ENHANCEMENT_RULES };
      }
      return msg;
    });

    return { ...params, prompt: enhancedPrompt };
  },
};
