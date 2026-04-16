/**
 * audit tools — 代码审计工具集
 *
 * 混合策略：规则引擎（零成本）+ LLM（深度分析）
 * 供 Code Auditor Agent 使用
 */

import { tool } from 'ai';
import { z } from 'zod';
import { scanSecurity, hasBlockingIssues } from '../../rules/security-rules.js';
import { scanA11y } from '../../rules/a11y-rules.js';
import { scanPerformance } from '../../rules/performance-rules.js';

/**
 * 安全扫描工具 — 基于规则引擎，零 LLM 成本
 */
export const securityScanTool = tool({
  description: '对代码执行安全扫描，检测 XSS、注入、敏感数据泄露等风险（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待扫描的代码'),
    strict: z.boolean().default(false).describe('是否严格模式（info 级也算问题）'),
  }),
  execute: async ({ code, strict }) => {
    const issues = scanSecurity(code);
    const blocking = hasBlockingIssues(issues);

    return {
      passed: strict ? issues.length === 0 : !blocking,
      blocking,
      totalIssues: issues.length,
      critical: issues.filter((i) => i.severity === 'critical').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
      issues,
      scannedAt: new Date().toISOString(),
    };
  },
});

/**
 * 无障碍检查工具 — 基于规则引擎，零 LLM 成本
 */
export const a11yScanTool = tool({
  description:
    '检查代码的无障碍合规性（WCAG 2.1），检测图片 alt、表单标签、语义化等（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待检查的代码'),
    wcagLevel: z.enum(['A', 'AA', 'AAA']).default('AA'),
  }),
  execute: async ({ code, wcagLevel }) => {
    const issues = scanA11y(code);

    return {
      wcagLevel,
      passed: issues.filter((i) => i.severity === 'critical').length === 0,
      totalIssues: issues.length,
      issues,
      scannedAt: new Date().toISOString(),
    };
  },
});

/**
 * 性能分析工具 — 基于规则引擎，零 LLM 成本
 */
export const performanceScanTool = tool({
  description: '分析代码的性能反模式（内联对象、index key、大型库整包导入等）（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待分析的代码'),
    framework: z.string().default('react').describe('前端框架'),
  }),
  execute: async ({ code }) => {
    const issues = scanPerformance(code);

    return {
      passed: issues.filter((i) => i.severity === 'critical').length === 0,
      totalIssues: issues.length,
      issues,
      scannedAt: new Date().toISOString(),
    };
  },
});

/**
 * 综合审计报告工具 — 一次跑完所有规则引擎
 */
export const fullAuditTool = tool({
  description: '执行完整的静态审计（安全 + 无障碍 + 性能），生成综合报告（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待审计的代码'),
    framework: z.string().default('react').describe('前端框架'),
  }),
  execute: async ({ code }) => {
    const security = scanSecurity(code);
    const a11y = scanA11y(code);
    const performance = scanPerformance(code);

    const totalCritical =
      security.filter((i) => i.severity === 'critical').length +
      a11y.filter((i) => i.severity === 'critical').length +
      performance.filter((i) => i.severity === 'critical').length;

    const totalWarnings =
      security.filter((i) => i.severity === 'warning').length +
      a11y.filter((i) => i.severity === 'warning').length +
      performance.filter((i) => i.severity === 'warning').length;

    // 计算综合评分（10分制）
    const deductions = totalCritical * 2 + totalWarnings * 0.5;
    const score = Math.max(0, Math.min(10, 10 - deductions));

    return {
      overallScore: Math.round(score * 10) / 10,
      passed: totalCritical === 0,
      summary: {
        critical: totalCritical,
        warnings: totalWarnings,
        info:
          security.filter((i) => i.severity === 'info').length +
          a11y.filter((i) => i.severity === 'info').length +
          performance.filter((i) => i.severity === 'info').length,
      },
      details: {
        security: { issues: security, passed: !hasBlockingIssues(security) },
        a11y: { issues: a11y, passed: a11y.filter((i) => i.severity === 'critical').length === 0 },
        performance: {
          issues: performance,
          passed: performance.filter((i) => i.severity === 'critical').length === 0,
        },
      },
      scannedAt: new Date().toISOString(),
    };
  },
});
