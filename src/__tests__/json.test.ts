/**
 * @file __tests__/json.test.ts — safeParseJson 单元测试
 *
 * 本测试文件验证 utils/json.ts 中 safeParseJson() 函数的正确性。
 * 覆盖的测试场景：
 *   - 基础 happy path：标准 JSON 解析
 *   - Markdown code fence 去除
 *   - 中文前缀/后缀文本去除
 *   - 尾逗号修复（trailing commas）
 *   - 字符串值中包含 {} [] 等特殊字符的正确处理（最关键的边界场景）
 *   - 深层嵌套对象/数组
 *   - 顶层数组解析
 *   - 转义引号处理
 *   - 无效输入的错误抛出
 *
 * 使用 Vitest 作为测试框架。
 */
import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../utils/json';

/**
 * 辅助函数：解析 JSON 文本并强制转换为 Record 类型，方便测试中的属性访问。
 * @param text - 待解析的文本
 * @returns 解析后的 Record 对象
 */
function parse(text: string): Record<string, unknown> {
  return safeParseJson(text) as Record<string, unknown>;
}

describe('safeParseJson', () => {
  // ── 基础 happy path —— 标准 JSON 解析 ──

  it('should parse valid JSON', () => {
    const result = parse('{"name": "test"}');
    expect(result).toEqual({ name: 'test' });
  });

  it('should strip markdown code fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = parse(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('should strip prefix text before JSON', () => {
    const input = '好的，以下是结果：\n{"status": "ok"}';
    const result = parse(input);
    expect(result).toEqual({ status: 'ok' });
  });

  it('should fix trailing commas', () => {
    const input = '{"a": 1, "b": 2,}';
    const result = parse(input);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should throw on completely invalid input', () => {
    expect(() => safeParseJson('not json at all')).toThrow();
  });

  // ── 关键边界场景：字符串值中包含括号字符 ──
  // 这是 safeParseJson 最重要的测试 —— 确保不会被字符串值中的 {} [] 误导截断

  it('should NOT truncate when string value contains }', () => {
    const input = '{"code": "function foo() { return 1; }", "name": "test"}';
    const result = parse(input);
    expect(result).toEqual({ code: 'function foo() { return 1; }', name: 'test' });
  });

  it('should NOT truncate when string value contains ] and }', () => {
    const input = '{"selector": "div[class=\\"foo\\"] > span", "ok": true}';
    const result = parse(input);
    expect(result).toEqual({ selector: 'div[class="foo"] > span', ok: true });
  });

  it('should handle CSS code in string values', () => {
    const input = '{"css": ".container { display: flex; } .item { color: red; }"}';
    const result = parse(input);
    expect(result.css).toBe('.container { display: flex; } .item { color: red; }');
  });

  it('should handle nested JSON-like content in strings', () => {
    const input = '{"content": "用户说: {\\"name\\": \\"张三\\"}，然后离开了", "id": 1}';
    const result = parse(input);
    expect(result.id).toBe(1);
    expect(result.content).toContain('张三');
  });

  it('should handle string with trailing } followed by suffix text', () => {
    const input = '以下是结果：\n{"code": "if (x) { return; }"}\n希望对你有帮助！';
    const result = parse(input);
    expect(result.code).toBe('if (x) { return; }');
  });

  // ── 数组和对象的深层嵌套 ──

  it('should handle deeply nested objects', () => {
    const input = '{"a": {"b": {"c": [1, 2, {"d": "e"}]}}}';
    const result = parse(input) as { a: { b: { c: [number, number, { d: string }] } } };
    expect(result.a.b.c[2].d).toBe('e');
  });

  it('should handle top-level arrays', () => {
    const input = '[{"name": "a"}, {"name": "b"}]';
    const result = safeParseJson(input) as Array<{ name: string }>;
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe('b');
  });

  it('should handle arrays with nested objects containing braces in strings', () => {
    const input = '[{"code": "() => { return [1,2]; }"}]';
    const result = safeParseJson(input) as Array<{ code: string }>;
    expect(result[0].code).toBe('() => { return [1,2]; }');
  });

  // ── 前后缀混杂 —— 模拟 LLM 在 JSON 前后添加自然语言 ──

  it('should strip Chinese prefix and suffix', () => {
    const input = '好的，这是你要的JSON：\n{"result": true}\n以上就是结果。';
    const result = parse(input);
    expect(result).toEqual({ result: true });
  });

  it('should handle multiple code fences with only the JSON one', () => {
    const input = '```json\n{"files": [{"name": "App.tsx", "content": "export default () => {}"}]}\n```\n\n以上代码已生成完毕。';
    const result = parse(input) as { files: Array<{ name: string }> };
    expect(result.files[0].name).toBe('App.tsx');
  });

  // ── 尾逗号边界 —— 验证非字符串上下文中的尾逗号修复 ──

  it('should fix trailing comma in nested structure', () => {
    const input = '{"items": [1, 2, 3,], "meta": {"count": 3,}}';
    const result = parse(input) as { items: number[]; meta: { count: number } };
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.meta.count).toBe(3);
  });

  it('should NOT remove comma-brace inside strings', () => {
    const input = '{"text": "a,}b", "ok": true}';
    const result = parse(input);
    expect(result.text).toBe('a,}b');
    expect(result.ok).toBe(true);
  });

  // ── 转义引号 —— 验证字符串内的转义引号不会破坏解析 ──

  it('should handle escaped quotes in strings', () => {
    const input = '{"html": "<div class=\\"test\\">hello</div>"}';
    const result = parse(input);
    expect(result.html).toBe('<div class="test">hello</div>');
  });
});
