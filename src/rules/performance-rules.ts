/**
 * performance-rules.ts — 前端性能规则引擎
 *
 * 静态检测常见的 React/Vue 性能反模式。
 * 零 LLM 成本，比让模型找性能问题更可靠。
 */

import type { Severity } from './security-rules.js';

export interface PerformanceIssue {
  severity: Severity;
  rule: string;
  message: string;
  suggestion: string;
  count: number;
}

interface PerfRule {
  id: string;
  check: (code: string) => number;
  severity: Severity;
  message: string;
  suggestion: string;
}

const RULES: PerfRule[] = [
  // ── React 特有 ─────────────────────────────
  {
    id: 'PERF-REACT-001',
    severity: 'warning',
    message: '在 JSX 中定义内联对象/数组，每次渲染都会创建新引用',
    suggestion: '提取为组件外常量或使用 useMemo',
    check: (code) => {
      // 检测 style={{ ... }} 或 prop={[ ... ]} 模式
      const inlineObjects = code.match(/=\{\s*\{[^}]*\}\s*\}/g) ?? [];
      const inlineArrays = code.match(/=\{\s*\[[^\]]*\]\s*\}/g) ?? [];
      return inlineObjects.length + inlineArrays.length;
    },
  },
  {
    id: 'PERF-REACT-002',
    severity: 'warning',
    message: '在 JSX 中定义内联箭头函数，会导致子组件不必要的重渲染',
    suggestion: '使用 useCallback 或提取为命名函数',
    check: (code) => {
      // 检测 onClick={() => ...} 模式
      const inlineFns = code.match(/=\{\s*\(\s*\)\s*=>/g) ?? [];
      const inlineFns2 = code.match(/=\{\s*\([^)]*\)\s*=>/g) ?? [];
      return Math.max(inlineFns.length, inlineFns2.length) > 3 ? 1 : 0;
    },
  },
  {
    id: 'PERF-REACT-003',
    severity: 'critical',
    message: '在循环/map 中使用 index 作为 key，列表变动时会导致性能问题和状态错乱',
    suggestion: '使用稳定的唯一标识符作为 key',
    check: (code) => {
      const indexKeys = code.match(/key\s*=\s*\{\s*(?:index|i|idx)\s*\}/g) ?? [];
      return indexKeys.length;
    },
  },
  {
    id: 'PERF-REACT-004',
    severity: 'warning',
    message: '组件体积过大（超过 200 行），建议拆分为更小的子组件',
    suggestion: '按职责拆分：容器组件 + 展示组件',
    check: (code) => {
      const lines = code.split('\n').length;
      return lines > 200 ? 1 : 0;
    },
  },

  // ── 通用前端 ───────────────────────────────
  {
    id: 'PERF-DOM-001',
    severity: 'warning',
    message: '在循环中直接操作 DOM，可能导致布局抖动（layout thrashing）',
    suggestion: '批量操作或使用 requestAnimationFrame',
    check: (code) => {
      // for/while 循环中包含 DOM 操作
      const hasLoopDOM =
        /(?:for|while)\s*\([^)]*\)\s*\{[^}]*(?:getElementById|querySelector|style\.\w+\s*=)/s.test(
          code,
        );
      return hasLoopDOM ? 1 : 0;
    },
  },
  {
    id: 'PERF-BUNDLE-001',
    severity: 'warning',
    message: '整包导入了大型库，建议使用按需导入减小包体积',
    suggestion: '使用 import { specific } from "lib" 替代 import lib from "lib"',
    check: (code) => {
      const bigLibs = ['lodash', 'moment', 'antd', 'material-ui', '@mui/material'];
      let count = 0;
      for (const lib of bigLibs) {
        // 检测 import xxx from 'lodash' （非 import { xxx } from 'lodash'）
        const fullImport = new RegExp(`import\\s+\\w+\\s+from\\s+['"\`]${lib}['"\`]`, 'g');
        count += (code.match(fullImport) ?? []).length;
      }
      return count;
    },
  },
  {
    id: 'PERF-ASYNC-001',
    severity: 'info',
    message: '存在串行的 await 调用，如果相互独立可以改用 Promise.all 并行执行',
    suggestion: '将独立的异步调用改为 Promise.all([...]) 并行执行',
    check: (code) => {
      // 连续的 await 行数
      const lines = code.split('\n');
      let consecutiveAwaits = 0;
      let maxConsecutive = 0;
      for (const line of lines) {
        if (/\bawait\b/.test(line)) {
          consecutiveAwaits++;
          maxConsecutive = Math.max(maxConsecutive, consecutiveAwaits);
        } else {
          consecutiveAwaits = 0;
        }
      }
      return maxConsecutive >= 3 ? 1 : 0;
    },
  },
];

/**
 * 扫描代码的性能问题
 */
export function scanPerformance(code: string): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];

  for (const rule of RULES) {
    const count = rule.check(code);
    if (count > 0) {
      issues.push({
        severity: rule.severity,
        rule: rule.id,
        message: rule.message,
        suggestion: rule.suggestion,
        count,
      });
    }
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return issues;
}
