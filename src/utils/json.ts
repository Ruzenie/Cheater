/**
 * @file json.ts — JSON 安全解析工具
 *
 * 在 Cheater 多模型代码生成系统中，不同 LLM（特别是弱模型如 DeepSeek、火山引擎等）
 * 的 JSON 输出经常存在格式偏差，包括但不限于：
 *   - 被 ```json ``` markdown code fence 包裹
 *   - 开头有「好的，以下是...」等自然语言废话前缀
 *   - 结尾有额外的说明性文字后缀
 *   - 尾逗号（trailing comma）导致 JSON.parse 失败
 *   - 字符串值中包含 {} [] 等字符导致误截
 *
 * 本文件提供 safeParseJson() 函数统一处理这些问题，
 * 确保从各种格式偏差的模型输出中可靠地提取 JSON 数据。
 * 所有 Agent 在解析 LLM 输出时都应使用此函数。
 */

/**
 * 从文本中找到第一个顶层 JSON 值（对象或数组）的结束位置。
 *
 * 使用字符栈追踪 {} 和 [] 的嵌套配对关系，
 * 正确处理字符串值中的 {} [] 和转义引号（\"），不会误截。
 *
 * 算法流程：
 *   1. 确认起始字符是 { 或 [
 *   2. 逐字符扫描，维护括号栈和字符串上下文状态
 *   3. 当栈清空时说明找到了顶层 JSON 的闭合位置
 *
 * @param text - 待扫描的文本
 * @param startIndex - 起始扫描位置（应指向 { 或 [）
 * @returns 顶层 JSON 值的结束索引（含），如果找不到或不匹配返回 -1
 */
function findJsonBoundary(text: string, startIndex: number): number {
  const first = text[startIndex];
  // 起始字符必须是 { 或 [，否则不是有效的 JSON 对象/数组
  if (first !== '{' && first !== '[') return -1;

  // 使用独立的栈来追踪括号配对，支持 {} 和 [] 的嵌套
  const stack: string[] = [];
  let inString = false;   // 当前是否处于字符串值内部
  let escaped = false;     // 上一个字符是否是转义符 \

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      // 前一个字符是 \，当前字符是转义序列的一部分，跳过
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      // 在字符串内遇到 \，标记下一个字符为转义
      escaped = true;
      continue;
    }

    if (ch === '"') {
      // 切换字符串上下文（进入或离开字符串）
      inString = !inString;
      continue;
    }

    // 在字符串内部的任何字符都不影响括号匹配
    if (inString) continue;

    // 非字符串上下文中的括号处理
    if (ch === '{' || ch === '[') {
      stack.push(ch);  // 开括号入栈
    } else if (ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') return -1; // 括号不匹配
      stack.pop();
      if (stack.length === 0) return i;  // 栈清空，找到顶层 JSON 的结束位置
    } else if (ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') return -1; // 括号不匹配
      stack.pop();
      if (stack.length === 0) return i;  // 栈清空，找到顶层 JSON 的结束位置
    }
  }

  return -1; // 扫描结束仍未闭合，JSON 不完整
}

/**
 * 从 LLM 模型输出文本中提取并解析 JSON。
 *
 * 兼容常见的格式偏差，处理流程：
 *   1. 去除 markdown code fence 包裹
 *   2. 定位第一个 { 或 [ 字符位置
 *   3. 去除 JSON 之前的自然语言前缀（限 200 字符内）
 *   4. 使用字符串上下文感知的边界检测，精确截取 JSON 区域
 *   5. 修复尾逗号
 *   6. 调用 JSON.parse 解析
 *
 * @param text - LLM 的原始输出文本
 * @returns 解析后的 JSON 值（对象、数组或原始值）
 * @throws {SyntaxError} 当清洗后仍无法解析为合法 JSON 时抛出
 */
export function safeParseJson(text: string): unknown {
  // 第一步：去掉 markdown code fence（支持 json/typescript/tsx/jsx/html/css 等语言标记）
  let cleaned = text
    .replace(/^```(?:json|typescript|tsx|javascript|jsx|html|css)?\s*\n?/gm, '')
    .replace(/\n?\s*```\s*$/gm, '');

  // 第二步：找到第一个 { 或 [，确定 JSON 起始位置
  const jsonStart = cleaned.search(/[{\[]/);
  if (jsonStart < 0) {
    // 没有找到对象/数组标记，尝试直接解析（可能是原始值如 true / 42 / "hello"）
    return JSON.parse(cleaned.trim());
  }

  // 第三步：去掉 JSON 之前的非 JSON 前缀文本（仅在前缀较短时，限 200 字符内）
  if (jsonStart > 0 && jsonStart < 200) {
    cleaned = cleaned.slice(jsonStart);
  }

  // 第四步：使用字符串上下文感知的边界检测，精确找到顶层 JSON 的结束位置
  const endIndex = findJsonBoundary(cleaned, 0);
  if (endIndex > 0 && endIndex < cleaned.length - 1) {
    // 截掉 JSON 后面的多余文本（如「希望对你有帮助！」）
    cleaned = cleaned.slice(0, endIndex + 1);
  }

  // 第五步：修复尾逗号（仅处理非字符串上下文中的逗号）
  cleaned = fixTrailingCommas(cleaned);

  return JSON.parse(cleaned);
}

/**
 * 修复 JSON 文本中的尾逗号（trailing commas）。
 *
 * 尾逗号（如 [1, 2, 3,] 或 {"a": 1,}）在标准 JSON 中是非法的，
 * 但部分 LLM 会生成这种格式。
 *
 * 本函数逐字符扫描，仅移除非字符串上下文中紧跟 } 或 ] 的逗号。
 * 字符串值中的 ",}" 或 ",]" 序列不会被错误处理。
 *
 * @param text - 含有尾逗号的 JSON 文本
 * @returns 修复后的 JSON 文本
 */
function fixTrailingCommas(text: string): string {
  const result: string[] = [];
  let inString = false;   // 当前是否处于字符串内部
  let escaped = false;     // 上一个字符是否是转义符

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
      // 向前看：跳过空白字符，如果下一个非空白字符是 } 或 ]，说明是尾逗号
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        continue; // 跳过这个尾逗号，不添加到结果中
      }
    }

    result.push(ch);
  }

  return result.join('');
}
