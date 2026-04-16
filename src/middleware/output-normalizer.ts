/**
 * output-normalizer.ts — 输出格式矫正中间件
 *
 * 弱模型常见问题：
 *   - 返回的 JSON 被 ```json ``` 包裹
 *   - 尾逗号导致 JSON.parse 失败
 *   - 输出前后有多余文字
 *
 * 兼容性：
 *   - 第三方 Provider（DeepSeek、火山引擎等）不支持 json_schema 格式，
 *     transformParams 会将 response_format 降级为不带 schema 的 json 模式。
 *     AI SDK 的 Output.object() 仍会在 prompt 中注入 schema 信息来引导模型输出。
 *
 * 架构说明：
 *   - transformParams: 对 generateText 和 streamText 均生效（降级 json_schema）
 *   - wrapGenerate:    仅对 generateText 生效 — 清洗输出中的 code fence / 尾逗号 / 废话前后缀
 *   - wrapStream:      不实现 — 流式场景下输出清洗由各 agent 的 safeParseJson() 统一处理
 *                      （见 src/utils/json.ts）
 *
 * 当前项目已全面使用 streamText，wrapGenerate 主要作为 generateText 的兜底保障。
 */

import type { LanguageModelMiddleware } from 'ai';

export const outputNormalizerMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  // ── transformParams: 降级 json_schema → json_object ──
  // 第三方 OpenAI-compatible 模型不支持 json_schema，但支持 json_object
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

    // 1. 去掉 markdown code fence
    text = text.replace(/^```(?:json|typescript|tsx|javascript|jsx|html|css)?\s*\n?/gm, '');
    text = text.replace(/\n?\s*```\s*$/gm, '');

    // 2. 修复尾逗号
    text = text.replace(/,(\s*[}\]])/g, '$1');

    // 3. 去掉开头可能的 "好的，" / "以下是" 等中文废话前缀（仅当内容看起来像JSON时）
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

    // 4. 同样处理尾部多余内容
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
