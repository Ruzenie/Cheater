import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../utils/json';

describe('safeParseJson', () => {
  // ── 基础 happy path ──

  it('should parse valid JSON', () => {
    const result = safeParseJson('{"name": "test"}');
    expect(result).toEqual({ name: 'test' });
  });

  it('should strip markdown code fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = safeParseJson(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('should strip prefix text before JSON', () => {
    const input = '好的，以下是结果：\n{"status": "ok"}';
    const result = safeParseJson(input);
    expect(result).toEqual({ status: 'ok' });
  });

  it('should fix trailing commas', () => {
    const input = '{"a": 1, "b": 2,}';
    const result = safeParseJson(input);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should throw on completely invalid input', () => {
    expect(() => safeParseJson('not json at all')).toThrow();
  });

  // ── CRITICAL: 字符串值中包含括号 ──

  it('should NOT truncate when string value contains }', () => {
    const input = '{"code": "function foo() { return 1; }", "name": "test"}';
    const result = safeParseJson(input);
    expect(result).toEqual({ code: 'function foo() { return 1; }', name: 'test' });
  });

  it('should NOT truncate when string value contains ] and }', () => {
    const input = '{"selector": "div[class=\\"foo\\"] > span", "ok": true}';
    const result = safeParseJson(input);
    expect(result).toEqual({ selector: 'div[class="foo"] > span', ok: true });
  });

  it('should handle CSS code in string values', () => {
    const input = '{"css": ".container { display: flex; } .item { color: red; }"}';
    const result = safeParseJson(input);
    expect(result.css).toBe('.container { display: flex; } .item { color: red; }');
  });

  it('should handle nested JSON-like content in strings', () => {
    const input = '{"content": "用户说: {\\"name\\": \\"张三\\"}，然后离开了", "id": 1}';
    const result = safeParseJson(input);
    expect(result.id).toBe(1);
    expect(result.content).toContain('张三');
  });

  it('should handle string with trailing } followed by suffix text', () => {
    const input = '以下是结果：\n{"code": "if (x) { return; }"}\n希望对你有帮助！';
    const result = safeParseJson(input);
    expect(result.code).toBe('if (x) { return; }');
  });

  // ── 数组/对象嵌套 ──

  it('should handle deeply nested objects', () => {
    const input = '{"a": {"b": {"c": [1, 2, {"d": "e"}]}}}';
    const result = safeParseJson(input);
    expect(result.a.b.c[2].d).toBe('e');
  });

  it('should handle top-level arrays', () => {
    const input = '[{"name": "a"}, {"name": "b"}]';
    const result = safeParseJson(input);
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe('b');
  });

  it('should handle arrays with nested objects containing braces in strings', () => {
    const input = '[{"code": "() => { return [1,2]; }"}]';
    const result = safeParseJson(input);
    expect(result[0].code).toBe('() => { return [1,2]; }');
  });

  // ── 前后缀混杂 ──

  it('should strip Chinese prefix and suffix', () => {
    const input = '好的，这是你要的JSON：\n{"result": true}\n以上就是结果。';
    const result = safeParseJson(input);
    expect(result).toEqual({ result: true });
  });

  it('should handle multiple code fences with only the JSON one', () => {
    const input = '```json\n{"files": [{"name": "App.tsx", "content": "export default () => {}"}]}\n```\n\n以上代码已生成完毕。';
    const result = safeParseJson(input);
    expect(result.files[0].name).toBe('App.tsx');
  });

  // ── 尾逗号边界 ──

  it('should fix trailing comma in nested structure', () => {
    const input = '{"items": [1, 2, 3,], "meta": {"count": 3,}}';
    const result = safeParseJson(input);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.meta.count).toBe(3);
  });

  it('should NOT remove comma-brace inside strings', () => {
    const input = '{"text": "a,}b", "ok": true}';
    const result = safeParseJson(input);
    expect(result.text).toBe('a,}b');
    expect(result.ok).toBe(true);
  });

  // ── 转义引号 ──

  it('should handle escaped quotes in strings', () => {
    const input = '{"html": "<div class=\\"test\\">hello</div>"}';
    const result = safeParseJson(input);
    expect(result.html).toBe('<div class="test">hello</div>');
  });
});
