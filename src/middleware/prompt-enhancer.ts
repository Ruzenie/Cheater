/**
 * @file prompt-enhancer.ts — Prompt 增强中间件
 *
 * @description
 * 本文件实现了 Prompt 增强中间件，专为弱模型（Tier 1 执行器模型）设计。
 * 在 system prompt 末尾自动追加一组结构化约束规则，
 * 提高弱模型的输出质量和格式一致性。
 *
 * 在 Cheater 系统中的角色：
 *   Cheater 采用多层模型路由策略，其中 Tier 1 模型（如 doubao-lite）
 *   负责执行具体的代码生成任务。这些模型虽然成本低，但输出质量不稳定。
 *   此中间件通过在 prompt 中注入额外约束，引导弱模型：
 *     - 输出合法 JSON（不包裹 markdown 代码块）
 *     - 使用 TypeScript 严格模式
 *     - 遵循命名规范（camelCase / PascalCase）
 *     - 控制函数长度（不超过 30 行）
 *     - 处理边界情况（null / undefined）
 *
 * 技术细节：
 *   - 仅实现 transformParams，对 generateText 和 streamText 均生效
 *   - 只修改 role=system 的消息，在其内容末尾追加规则
 *   - 不影响 user/assistant 消息内容
 *   - 只在 executor 模型上启用，不会增加高级模型的 token 消耗
 */

import type { LanguageModelMiddleware } from 'ai';

/**
 * 增强规则文本
 *
 * @description
 * 追加到 system prompt 末尾的结构化约束规则。
 * 包含两大类规则：
 *   - [结构化输出约束]：规范 JSON 输出格式，确保字段完整
 *   - [代码输出约束]：规范代码风格，确保 TypeScript 最佳实践
 */
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

/**
 * Prompt 增强中间件
 *
 * @description
 * 遵循 AI SDK v6 LanguageModelV3Middleware 规范。
 * 仅实现 transformParams，在请求发出前修改 system prompt。
 * 找到 role=system 且内容为字符串的消息，在末尾追加增强规则。
 */
export const promptEnhancerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  transformParams: async ({ params }) => {
    // 遍历 prompt 消息数组，找到 system 消息并追加增强规则
    const enhancedPrompt = params.prompt.map((msg) => {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        // 只修改字符串类型的 system 消息内容，数组类型的不处理
        return { ...msg, content: msg.content + ENHANCEMENT_RULES };
      }
      return msg;
    });

    return { ...params, prompt: enhancedPrompt };
  },
};
