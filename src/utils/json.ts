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
 * 从文本中找到第一个顶层 JSON 值（对象或数组）的结束位置。
 * 正确处理字符串内的 {} [] 和转义引号，不会误截。
 *
 * @returns 顶层 JSON 值的结束索引（含），如果找不到返回 -1
 */
function findJsonBoundary(text: string, startIndex: number): number {
  const first = text[startIndex];
  if (first !== '{' && first !== '[') return -1;

  // 使用独立的栈来追踪括号配对，正确处理 {} 和 [] 的嵌套
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') return -1; // 不匹配
      stack.pop();
      if (stack.length === 0) return i;
    } else if (ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') return -1; // 不匹配
      stack.pop();
      if (stack.length === 0) return i;
    }
  }

  return -1; // 未闭合
}

/**
 * 从模型输出中提取并解析 JSON，兼容常见格式偏差。
 * 使用字符串上下文感知的边界检测，不会被字符串值中的 {} [] 误导。
 *
 * @throws {SyntaxError} 当清洗后仍无法解析为合法 JSON 时抛出
 */
export function safeParseJson(text: string): unknown {
  // 1. 去掉 markdown code fence
  let cleaned = text
    .replace(/^```(?:json|typescript|tsx|javascript|jsx|html|css)?\s*\n?/gm, '')
    .replace(/\n?\s*```\s*$/gm, '');

  // 2. 找到第一个 { 或 [
  const jsonStart = cleaned.search(/[{\[]/);
  if (jsonStart < 0) {
    // 没有找到对象/数组，尝试直接解析（可能是原始值）
    return JSON.parse(cleaned.trim());
  }

  // 3. 去掉开头的非 JSON 前缀（前缀 < 200 字符时）
  if (jsonStart > 0 && jsonStart < 200) {
    cleaned = cleaned.slice(jsonStart);
  }

  // 4. 使用字符串上下文感知的边界检测，找到顶层 JSON 的结束位置
  const endIndex = findJsonBoundary(cleaned, 0);
  if (endIndex > 0 && endIndex < cleaned.length - 1) {
    cleaned = cleaned.slice(0, endIndex + 1);
  }

  // 5. 修复尾逗号（仅在非字符串上下文中）
  cleaned = fixTrailingCommas(cleaned);

  return JSON.parse(cleaned);
}

/**
 * 修复 JSON 中的尾逗号，仅处理非字符串上下文中的逗号。
 * 避免破坏字符串值中的合法 ",}" 或 ",]" 序列。
 */
function fixTrailingCommas(text: string): string {
  const result: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      result.push(ch);
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      result.push(ch);
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result.push(ch);
      continue;
    }

    if (!inString && ch === ',') {
      // 向前看：跳过空白，如果下一个非空白字符是 } 或 ]，跳过这个逗号
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        continue; // 跳过尾逗号
      }
    }

    result.push(ch);
  }

  return result.join('');
}
