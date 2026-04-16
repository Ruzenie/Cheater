/**
 * a11y-rules.ts — 无障碍合规规则引擎
 *
 * 基于 WCAG 2.1 AA 级别的常见检查项。
 * 零 LLM 成本，适合作为第一道质量门禁。
 */

import type { Severity } from './security-rules.js';

export interface A11yIssue {
  severity: Severity;
  rule: string;
  message: string;
  count: number;
}

interface A11yRule {
  id: string;
  check: (code: string) => number; // 返回问题数量，0 = 通过
  severity: Severity;
  message: string;
}

const RULES: A11yRule[] = [
  // ── 图片 ───────────────────────────────────
  {
    id: 'A11Y-IMG-001',
    severity: 'critical',
    message: '<img> 标签缺少 alt 属性',
    check: (code) => {
      const imgTags = code.match(/<img\b[^>]*>/gi) ?? [];
      return imgTags.filter((tag) => !/\balt\s*=/i.test(tag)).length;
    },
  },

  // ── 表单 ───────────────────────────────────
  {
    id: 'A11Y-FORM-001',
    severity: 'critical',
    message: '<input> 缺少关联的 <label> 或 aria-label',
    check: (code) => {
      const inputs = code.match(/<input\b[^>]*>/gi) ?? [];
      return inputs.filter(
        (tag) =>
          !/\baria-label\s*=/i.test(tag) &&
          !/\baria-labelledby\s*=/i.test(tag) &&
          !/\bid\s*=/i.test(tag), // 有 id 可能外部有 label[for]
      ).length;
    },
  },
  {
    id: 'A11Y-FORM-002',
    severity: 'warning',
    message: '表单缺少 aria-required 或 required 属性',
    check: (code) => {
      const inputs = code.match(/<input\b[^>]*>/gi) ?? [];
      return inputs.filter((tag) => !/\brequired\b/i.test(tag) && !/\baria-required/i.test(tag))
        .length > 3
        ? 1
        : 0; // 超过3个无required的input才报
    },
  },

  // ── 按钮 ───────────────────────────────────
  {
    id: 'A11Y-BTN-001',
    severity: 'warning',
    message: '按钮缺少可访问的文本内容（无文字且无 aria-label）',
    check: (code) => {
      // 检测 <button></button> 或 <button /> 空按钮
      const emptyBtns = code.match(/<button[^>]*\/\s*>/gi) ?? [];
      const emptyBtns2 = code.match(/<button[^>]*>\s*<\/button>/gi) ?? [];
      return [...emptyBtns, ...emptyBtns2].filter((tag) => !/\baria-label\s*=/i.test(tag)).length;
    },
  },

  // ── 语义化 ─────────────────────────────────
  {
    id: 'A11Y-SEM-001',
    severity: 'warning',
    message: '页面缺少语义化标签（未使用 <main>, <nav>, <header>, <footer>）',
    check: (code) => {
      const semanticTags = ['<main', '<nav', '<header', '<footer', '<section', '<article'];
      const found = semanticTags.filter((tag) => code.includes(tag));
      // 如果超过100行的JSX但没有任何语义标签
      const lines = code.split('\n').length;
      return lines > 50 && found.length === 0 ? 1 : 0;
    },
  },
  {
    id: 'A11Y-SEM-002',
    severity: 'info',
    message: '存在连续点击处理但未设置 role 和 keyboard handler',
    check: (code) => {
      const clickDivs = code.match(/onClick[^}]*}/g) ?? [];
      const withRole = code.match(/role\s*=\s*['"`]button['"`]/g) ?? [];
      // 如果有onClick但role="button"数量少得多
      return clickDivs.length > 0 && withRole.length < clickDivs.length / 2 ? 1 : 0;
    },
  },

  // ── 颜色与对比 ─────────────────────────────
  {
    id: 'A11Y-COLOR-001',
    severity: 'info',
    message: '提示：无法静态检查颜色对比度，建议手动验证 WCAG AA 对比度比值 (4.5:1)',
    check: (code) => {
      // 如果有大量颜色定义，提醒检查
      const colors = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      return colors.length > 5 ? 1 : 0;
    },
  },

  // ── Focus ──────────────────────────────────
  {
    id: 'A11Y-FOCUS-001',
    severity: 'warning',
    message: '使用了 outline: none 或 outline: 0，可能破坏键盘导航的焦点可见性',
    check: (code) => {
      const outlineNone = code.match(/outline\s*:\s*(none|0)\b/gi) ?? [];
      return outlineNone.length;
    },
  },
];

/**
 * 扫描代码的无障碍合规性
 */
export function scanA11y(code: string): A11yIssue[] {
  const issues: A11yIssue[] = [];

  for (const rule of RULES) {
    const count = rule.check(code);
    if (count > 0) {
      issues.push({
        severity: rule.severity,
        rule: rule.id,
        message: rule.message,
        count,
      });
    }
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return issues;
}
