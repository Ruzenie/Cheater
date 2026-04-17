/**
 * @file a11y-rules.ts — 无障碍合规规则引擎
 *
 * @description
 * 本文件实现了基于 WCAG 2.1 AA 级别的零成本无障碍合规静态扫描器。
 * 通过正则表达式和字符串匹配，检测生成代码中常见的无障碍问题。
 *
 * 在 Cheater 系统中的角色：
 *   作为代码审计阶段的第一道质量门禁，在 LLM 审计之前先执行
 *   零成本的静态检查。检查结果会注入审计报告供 LLM 参考。
 *
 * 覆盖的检查项：
 *   图片类：
 *     - A11Y-IMG-001: <img> 标签缺少 alt 属性
 *
 *   表单类：
 *     - A11Y-FORM-001: <input> 缺少 label 或 aria-label
 *     - A11Y-FORM-002: 大量 input 缺少 required 属性
 *
 *   按钮类：
 *     - A11Y-BTN-001: 空按钮缺少 aria-label
 *
 *   语义化：
 *     - A11Y-SEM-001: 大段 JSX 未使用语义化标签
 *     - A11Y-SEM-002: 有 onClick 但缺少 role="button" 和键盘处理
 *
 *   颜色对比：
 *     - A11Y-COLOR-001: 存在大量颜色定义，提醒手动检查对比度
 *
 *   焦点管理：
 *     - A11Y-FOCUS-001: outline: none/0 破坏键盘导航可见性
 *
 * 注意：与 security-rules 不同，a11y 规则使用 check 函数而非纯正则，
 * 因为无障碍检查通常需要更复杂的逻辑（如计数、比例判断等）。
 */

import type { Severity } from './security-rules.js';

/**
 * 无障碍扫描结果中的单个问题
 */
export interface A11yIssue {
  /** 严重等级 */
  severity: Severity;
  /** 规则 ID（如 'A11Y-IMG-001'） */
  rule: string;
  /** 人类可读的问题描述（中文） */
  message: string;
  /** 问题出现的次数 */
  count: number;
}

/**
 * 内部无障碍规则定义
 *
 * @description
 * 与 SecurityRule 不同，A11yRule 使用 check 函数而非纯正则，
 * 因为无障碍检查通常需要更复杂的逻辑（如统计 input 数量、判断比例等）。
 */
interface A11yRule {
  /** 规则唯一标识符 */
  id: string;
  /** 检查函数：接收代码字符串，返回问题数量（0 表示通过） */
  check: (code: string) => number; // 返回问题数量，0 = 通过
  /** 严重等级 */
  severity: Severity;
  /** 问题描述 */
  message: string;
}

/** 预定义的无障碍规则列表，按检查类别分组 */
const RULES: A11yRule[] = [
  // ── 图片 ───────────────────────────────────
  // 检查 <img> 标签是否包含 alt 属性（WCAG 1.1.1）
  {
    id: 'A11Y-IMG-001',
    severity: 'critical',
    message: '<img> 标签缺少 alt 属性',
    check: (code) => {
      // 匹配所有 <img ...> 标签，然后过滤出没有 alt= 属性的
      const imgTags = code.match(/<img\b[^>]*>/gi) ?? [];
      return imgTags.filter((tag) => !/\balt\s*=/i.test(tag)).length;
    },
  },

  // ── 表单 ───────────────────────────────────
  // 检查 <input> 是否有关联的标签（WCAG 1.3.1, 4.1.2）
  {
    id: 'A11Y-FORM-001',
    severity: 'critical',
    message: '<input> 缺少关联的 <label> 或 aria-label',
    check: (code) => {
      // 匹配所有 <input> 标签，过滤出缺少 aria-label、aria-labelledby 和 id 的
      // 有 id 的 input 可能在外部有 <label for="..."> 关联
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
      // 统计缺少 required 的 input 数量，超过 3 个才报告（避免误报）
      const inputs = code.match(/<input\b[^>]*>/gi) ?? [];
      return inputs.filter((tag) => !/\brequired\b/i.test(tag) && !/\baria-required/i.test(tag))
        .length > 3
        ? 1
        : 0; // 超过3个无required的input才报
    },
  },

  // ── 按钮 ───────────────────────────────────
  // 检查空按钮是否有可访问的文本（WCAG 4.1.2）
  {
    id: 'A11Y-BTN-001',
    severity: 'warning',
    message: '按钮缺少可访问的文本内容（无文字且无 aria-label）',
    check: (code) => {
      // 检测两种空按钮模式：<button .../> 自闭合 和 <button>  </button> 空内容
      const emptyBtns = code.match(/<button[^>]*\/\s*>/gi) ?? [];
      const emptyBtns2 = code.match(/<button[^>]*>\s*<\/button>/gi) ?? [];
      // 过滤掉有 aria-label 的按钮
      return [...emptyBtns, ...emptyBtns2].filter((tag) => !/\baria-label\s*=/i.test(tag)).length;
    },
  },

  // ── 语义化 ─────────────────────────────────
  // 检查是否使用了 HTML5 语义化标签（WCAG 1.3.1）
  {
    id: 'A11Y-SEM-001',
    severity: 'warning',
    message: '页面缺少语义化标签（未使用 <main>, <nav>, <header>, <footer>）',
    check: (code) => {
      // 检查六种常用语义标签
      const semanticTags = ['<main', '<nav', '<header', '<footer', '<section', '<article'];
      const found = semanticTags.filter((tag) => code.includes(tag));
      // 仅在代码超过 50 行且完全没有语义标签时才报告
      const lines = code.split('\n').length;
      return lines > 50 && found.length === 0 ? 1 : 0;
    },
  },
  {
    id: 'A11Y-SEM-002',
    severity: 'info',
    message: '存在连续点击处理但未设置 role 和 keyboard handler',
    check: (code) => {
      // 统计 onClick 处理器和 role="button" 的数量
      // 如果 onClick 数量远多于 role="button"，说明存在可点击但不可键盘访问的元素
      const clickDivs = code.match(/onClick[^}]*}/g) ?? [];
      const withRole = code.match(/role\s*=\s*['"`]button['"`]/g) ?? [];
      // 当 role="button" 数量不到 onClick 数量的一半时报告
      return clickDivs.length > 0 && withRole.length < clickDivs.length / 2 ? 1 : 0;
    },
  },

  // ── 颜色与对比 ─────────────────────────────
  // 提示性检查：无法静态分析对比度，但可以提醒开发者关注
  {
    id: 'A11Y-COLOR-001',
    severity: 'info',
    message: '提示：无法静态检查颜色对比度，建议手动验证 WCAG AA 对比度比值 (4.5:1)',
    check: (code) => {
      // 匹配十六进制颜色值（3-8 位），超过 5 个颜色定义时提醒
      const colors = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      return colors.length > 5 ? 1 : 0;
    },
  },

  // ── Focus 焦点管理 ──────────────────────────────────
  // 检查是否破坏了键盘导航的焦点可见性（WCAG 2.4.7）
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
 *
 * @description
 * 遍历所有预定义的无障碍规则，对输入代码执行检查函数。
 * 每条 check 函数返回问题数量（0 表示通过），非零则生成 A11yIssue。
 * 结果按严重等级排序（critical → warning → info）。
 *
 * @param code - 要扫描的源代码字符串
 * @returns 无障碍问题列表，按严重等级排序
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
