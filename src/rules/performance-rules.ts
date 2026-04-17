/**
 * @file performance-rules.ts — 前端性能规则引擎
 *
 * @description
 * 本文件实现了零 LLM 成本的前端性能反模式静态扫描器。
 * 通过正则表达式和代码结构分析，检测生成代码中常见的性能问题。
 *
 * 在 Cheater 系统中的角色：
 *   在代码审计阶段，此扫描器与安全扫描器、无障碍扫描器一同构成
 *   "零成本质量门禁"层。扫描结果会注入审计报告，供 LLM 参考。
 *   比让 LLM 找性能问题更可靠——LLM 容易遗漏这类模式化问题。
 *
 * 覆盖的检查项：
 *   React 特有：
 *     - PERF-REACT-001: JSX 中的内联对象/数组（每次渲染创建新引用）
 *     - PERF-REACT-002: JSX 中的内联箭头函数（导致子组件不必要重渲染）
 *     - PERF-REACT-003: 循环中使用 index 作为 key（列表变动时状态错乱）
 *     - PERF-REACT-004: 组件超过 200 行（建议拆分）
 *
 *   通用前端：
 *     - PERF-DOM-001: 循环中直接操作 DOM（布局抖动）
 *     - PERF-BUNDLE-001: 整包导入大型库（包体积膨胀）
 *     - PERF-ASYNC-001: 串行 await 调用（可改用 Promise.all 并行）
 */

import type { Severity } from './security-rules.js';

/**
 * 性能扫描结果中的单个问题
 */
export interface PerformanceIssue {
  /** 严重等级 */
  severity: Severity;
  /** 规则 ID（如 'PERF-REACT-001'） */
  rule: string;
  /** 人类可读的问题描述（中文） */
  message: string;
  /** 改进建议 */
  suggestion: string;
  /** 问题出现的次数 */
  count: number;
}

/**
 * 内部性能规则定义
 *
 * @description
 * 与 A11yRule 类似，使用 check 函数进行检查。
 * 额外包含 suggestion 字段，提供具体的改进建议。
 */
interface PerfRule {
  /** 规则唯一标识符 */
  id: string;
  /** 检查函数：接收代码字符串，返回问题数量（0 表示通过） */
  check: (code: string) => number;
  /** 严重等级 */
  severity: Severity;
  /** 问题描述 */
  message: string;
  /** 改进建议 */
  suggestion: string;
}

/** 预定义的性能规则列表，按检查类别分组 */
const RULES: PerfRule[] = [
  // ── React 特有 ─────────────────────────────
  // 检测 React 组件中常见的性能反模式
  {
    id: 'PERF-REACT-001',
    severity: 'warning',
    message: '在 JSX 中定义内联对象/数组，每次渲染都会创建新引用',
    suggestion: '提取为组件外常量或使用 useMemo',
    check: (code) => {
      // 正则说明：匹配 style={{ ... }} 或 prop={[...]} 模式
      // 这些内联对象/数组在每次渲染时都会创建新的引用，
      // 导致依赖引用相等的优化（React.memo、useMemo）失效
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
      // 正则说明：匹配 onClick={() => ...} 和 onClick={(e) => ...} 模式
      // 内联箭头函数在每次渲染时创建新函数引用，导致子组件不必要重渲染
      // 仅当超过 3 个时才报告（少量内联函数影响不大）
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
      // 正则说明：匹配 key={index}、key={i}、key={idx} 模式
      // 使用数组索引作为 key 会导致列表项增删时组件状态混乱
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
  // 不限于特定框架的前端性能问题
  {
    id: 'PERF-DOM-001',
    severity: 'warning',
    message: '在循环中直接操作 DOM，可能导致布局抖动（layout thrashing）',
    suggestion: '批量操作或使用 requestAnimationFrame',
    check: (code) => {
      // 正则说明：使用 /s 标志（dotAll）匹配跨行内容
      // 检测 for/while 循环体内是否包含 getElementById、querySelector 或 style.xxx= 等 DOM 操作
      // 这类操作在循环中会导致浏览器反复计算布局（layout thrashing）
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
      // 检测大型库的默认导入（import xxx from 'lodash'）
      // 区别于按需导入（import { debounce } from 'lodash'）
      // 默认导入会将整个库打入 bundle，显著增大包体积
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
