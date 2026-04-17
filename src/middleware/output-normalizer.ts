/**
 * @file output-normalizer.ts — 输出格式矫正中间件
 *
 * @description
 * 本文件实现了 LLM 输出格式的自动矫正中间件，专门解决弱模型
 * （如 Tier 1 执行器模型）输出格式不规范的问题。
 *
 * 在 Cheater 系统中的角色：
 *   多模型管线中使用 JSON 作为步骤间的数据传递格式。
 *   弱模型（如 doubao-lite）经常产生不规范的 JSON 输出：
 *     - 用 ```json ``` 代码围栏包裹 JSON
 *     - 在 JSON 中使用尾逗号（非标准语法）
 *     - 在 JSON 前后添加中文废话（"好的，以下是…"）
 *   此中间件在 LLM 返回结果后自动清洗这些问题。
 *
 * 兼容性处理：
 *   第三方 Provider（DeepSeek、火山引擎等）通常不支持 json_schema 格式，
 *   transformParams 会将 response_format 从 json_schema 降级为
 *   不带 schema 的 json_object 模式。AI SDK 的 Output.object() 仍会在
 *   prompt 中注入 schema 信息来引导模型输出正确结构。
 *
 * 架构说明：
 *   - transformParams: 对 generateText 和 streamText 均生效 — 降级 json_schema
 *   - wrapGenerate: 仅对 generateText 生效 — 清洗输出中的 code fence / 尾逗号 / 废话前后缀
 *   - wrapStream: 不实现 — 流式场景下输出清洗由各 agent 的 safeParseJson() 统一处理
 *                 （见 src/utils/json.ts）
 *
 * 注意：当前项目已全面使用 streamText，wrapGenerate 主要作为 generateText 的兜底保障。
 */

import type { LanguageModelMiddleware } from 'ai';

/**
 * 输出格式矫正中间件
 *
 * @description
 * 遵循 AI SDK v6 LanguageModelV3Middleware 规范。
 * 通过 transformParams 降级 JSON schema 格式，
 * 通过 wrapGenerate 清洗输出中的格式问题。
 */
export const outputNormalizerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  // ── transformParams: 降级 json_schema → json_object ──
  // 第三方 OpenAI-compatible 模型不支持 json_schema，但支持 json_object。
  // 此处将带有 schema 的 json 格式降级为不带 schema 的 json 模式，
  // 同时确保 prompt 中包含 "json" 关键字（某些模型强制要求）。
  transformParams: async ({ params }) => {
    if (params.responseFormat?.type === 'json' && params.responseFormat.schema != null) {
      // 某些第三方模型（如 DeepSeek）要求 prompt 中包含 "json" 关键字
      // 才能使用 json_object 模式，确保至少有一条 system message 包含提示
      const messages = [...(params.prompt ?? [])];
      const hasJsonHint = messages.some(
        (m) => m.role === 'system' && m.content?.toString().toLowerCase().includes('json'),
      );
      if (!hasJsonHint) {
        messages.unshift({
          role: 'system' as const,
          content: 'Respond with valid JSON only.',
        });
      }

      return {
        ...params,
        prompt: messages,
        responseFormat: {
          type: 'json' as const,
          // 去掉 schema/name/description，让 SDK 发 { type: "json_object" }
        },
      };
    }
    return params;
  },

  /**
   * 包裹 generateText 调用，清洗输出中的格式问题
   *
   * @description
   * 清洗流程（按顺序执行）：
   *   1. 去掉 markdown code fence（```json、```tsx 等）
   *   2. 修复尾逗号（JSON 标准不允许尾逗号）
   *   3. 去掉 JSON 前的中文废话前缀（"好的，以下是…"）
   *   4. 去掉 JSON 后的多余尾部内容
   */
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();

    // V3: 文本内容在 result.content 数组中，类型为 { type: 'text', text: '...' }
    const textPart = result.content?.find(
      (p) => p.type === 'text',
    ) as
      | { type: 'text'; text: string }
      | undefined;
    if (!textPart) return result;

    let text = textPart.text;

    // 步骤 1: 去掉 markdown code fence（匹配 ```json、```typescript 等语言标记）
    text = text.replace(/^```(?:json|typescript|tsx|javascript|jsx|html|css)?\s*\n?/gm, '');
    text = text.replace(/\n?\s*```\s*$/gm, '');

    // 步骤 2: 修复尾逗号，如 {a:1,} → {a:1}，[1,2,] → [1,2]
    text = text.replace(/,(\s*[}\]])/g, '$1');

    // 步骤 3: 去掉开头可能的中文废话前缀（"好的，" / "以下是" 等）
    // 仅当内容看起来像 JSON（包含 { 或 [）且前缀不含有意义的代码字符时才裁剪
    if (text.includes('{') || text.includes('[')) {
      const jsonStart = text.search(/[{\[]/);
      if (jsonStart > 0 && jsonStart < 100) {
        const prefix = text.slice(0, jsonStart).trim();
        // 仅当前缀不含有意义的代码字符时才裁剪
        if (!/[=;(){}]/.test(prefix)) {
          text = text.slice(jsonStart);
        }
      }
    }

    // 步骤 4: 同样处理尾部多余内容（JSON 后面的解释性文字）
    if (text.includes('{') || text.includes('[')) {
      const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (lastBrace > 0 && lastBrace < text.length - 1) {
        const suffix = text.slice(lastBrace + 1).trim();
        if (suffix.length > 0 && !/[=;(){}]/.test(suffix)) {
          text = text.slice(0, lastBrace + 1);
        }
      }
    }

    // 返回新对象，避免突变原始 result
    const newContent = result.content.map((p) =>
      p === textPart ? { ...p, text } : p,
    );
    return { ...result, content: newContent } as typeof result;
  },
};
