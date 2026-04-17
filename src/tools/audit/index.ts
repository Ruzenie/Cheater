/**
 * @file tools/audit/index.ts — 代码审计工具集
 *
 * 本文件定义了 Code Auditor Agent 使用的全部审计工具。
 * 采用「混合策略」：规则引擎（零 LLM 成本）负责静态扫描，
 * LLM 负责更深层的语义分析（由 Agent 主循环驱动，不在本文件中）。
 *
 * 在 Cheater Pipeline 中的位置：
 *   需求精炼 → 设计分析 → 项目规划 → 代码生成 → **代码审计** → 代码组装
 *
 * 提供的工具：
 *   1. securityScanTool    — 安全扫描（XSS、注入、敏感数据泄露等）
 *   2. a11yScanTool        — 无障碍合规检查（WCAG 2.1）
 *   3. performanceScanTool — 性能反模式检测（大包导入、index key 等）
 *   4. fullAuditTool       — 综合审计（一次跑完安全 + 无障碍 + 性能）
 *
 * 所有工具底层调用 `../../rules/` 目录下的规则引擎模块，
 * 不消耗任何 LLM token，可大规模批量执行。
 */

import { tool } from 'ai';
import { z } from 'zod';
// 导入规则引擎模块 —— 这些模块包含预定义的静态分析规则
import { scanSecurity, hasBlockingIssues } from '../../rules/security-rules.js';
import { scanA11y } from '../../rules/a11y-rules.js';
import { scanPerformance } from '../../rules/performance-rules.js';

/**
 * securityScanTool — 安全扫描工具。
 *
 * 基于规则引擎执行安全扫描，检测 XSS、注入、敏感数据泄露等风险。
 * 零 LLM 成本，可高频调用。
 *
 * 支持两种模式：
 *   - 默认模式：仅 critical/warning 级别问题导致不通过
 *   - 严格模式（strict=true）：任何级别问题都算不通过
 *
 * @param code - 待扫描的代码字符串
 * @param strict - 是否启用严格模式（默认 false）
 * @returns 扫描结果，包含通过状态、问题分级统计和详细问题列表
 */
export const securityScanTool = tool({
  description: '对代码执行安全扫描，检测 XSS、注入、敏感数据泄露等风险（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待扫描的代码'),
    strict: z.boolean().default(false).describe('是否严格模式（info 级也算问题）'),
  }),
  execute: async ({ code, strict }) => {
    // 调用安全规则引擎，获取所有安全问题
    const issues = scanSecurity(code);
    // 检查是否有阻塞级别（critical）的问题
    const blocking = hasBlockingIssues(issues);

    return {
      // 默认模式下仅关注阻塞问题；严格模式下任何问题都不通过
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
 * a11yScanTool — 无障碍合规检查工具。
 *
 * 基于规则引擎检查代码的无障碍合规性（WCAG 2.1），
 * 检测图片 alt 缺失、表单标签缺失、语义化标签使用等问题。
 * 零 LLM 成本。
 *
 * @param code - 待检查的代码字符串
 * @param wcagLevel - WCAG 合规级别（A / AA / AAA，默认 AA）
 * @returns 检查结果，包含通过状态和详细问题列表
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
 * performanceScanTool — 性能反模式检测工具。
 *
 * 基于规则引擎分析代码中的性能反模式，包括：
 *   - 渲染内联对象（导致不必要的重渲染）
 *   - 使用 index 作为 key（列表重排性能问题）
 *   - 大型库整包导入（如 import _ from 'lodash'）
 * 零 LLM 成本。
 *
 * @param code - 待分析的代码字符串
 * @param framework - 前端框架（默认 'react'）
 * @returns 分析结果，包含通过状态和详细问题列表
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
 * fullAuditTool — 综合审计报告工具。
 *
 * 一次性执行所有规则引擎（安全 + 无障碍 + 性能），生成统一的综合报告。
 * 包含 10 分制评分系统：
 *   - 每个 critical 问题扣 2 分
 *   - 每个 warning 问题扣 0.5 分
 *   - 最终评分限制在 0-10 分范围内
 *
 * @param code - 待审计的代码字符串
 * @param framework - 前端框架（默认 'react'）
 * @returns 综合报告，包含总评分、分类详情和通过状态
 */
export const fullAuditTool = tool({
  description: '执行完整的静态审计（安全 + 无障碍 + 性能），生成综合报告（零 LLM 成本）',
  inputSchema: z.object({
    code: z.string().describe('待审计的代码'),
    framework: z.string().default('react').describe('前端框架'),
  }),
  execute: async ({ code }) => {
    // 分别运行三个规则引擎
    const security = scanSecurity(code);
    const a11y = scanA11y(code);
    const performance = scanPerformance(code);

    // 汇总各维度的 critical 数量
    const totalCritical =
      security.filter((i) => i.severity === 'critical').length +
      a11y.filter((i) => i.severity === 'critical').length +
      performance.filter((i) => i.severity === 'critical').length;

    // 汇总各维度的 warning 数量
    const totalWarnings =
      security.filter((i) => i.severity === 'warning').length +
      a11y.filter((i) => i.severity === 'warning').length +
      performance.filter((i) => i.severity === 'warning').length;

    // 计算综合评分（10分制）—— critical 扣 2 分，warning 扣 0.5 分
    const deductions = totalCritical * 2 + totalWarnings * 0.5;
    // 确保评分在 0-10 范围内
    const score = Math.max(0, Math.min(10, 10 - deductions));

    return {
      // 四舍五入到一位小数
      overallScore: Math.round(score * 10) / 10,
      // 只要没有 critical 问题就算通过
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
