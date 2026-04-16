/**
 * json.ts — JSON 安全解析工具
 *
 * 弱模型（DeepSeek、火山引擎等）的 JSON 输出常见问题：
 *   - 被 ```json ``` markdown code fence 包裹
 *   - 开头有 "好的，以下是..." 等废话前缀
 *   - 结尾有额外说明文字
 *   - 尾逗号导致 JSON.parse 失败
 *
 * 本函数统一处理这些问题，供所有 agent 使用。
 */

/**
 * 从模型输出中提取并解析 JSON，兼容常见格式偏差。
 *
 * @throws {SyntaxError} 当清洗后仍无法解析为合法 JSON 时抛出
 */
export function safeParseJson(text: string): any {
  // 1. 去掉 markdown code fence
  let cleaned = text
    .replace(/^```(?:json|typescript|tsx|javascript|jsx|html|css)?\s*\n?/gm, '')
    .replace(/\n?\s*```\s*$/gm, '');

  // 2. 去掉开头的非 JSON 内容（前缀 < 200 字符时）
  const jsonStart = cleaned.search(/[{\[]/);
  if (jsonStart > 0 && jsonStart < 200) {
    cleaned = cleaned.slice(jsonStart);
  }

  // 3. 去掉结尾的非 JSON 内容
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.slice(0, lastBrace + 1);
  }

  // 4. 修复尾逗号
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(cleaned);
}
