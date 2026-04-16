import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../utils/json';

describe('safeParseJson', () => {
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
});
