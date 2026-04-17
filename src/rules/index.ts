/**
 * @file rules/index.ts — 规则引擎模块的桶导出（Barrel Exports）
 *
 * @description
 * 本文件是 Cheater 系统中所有零成本静态规则扫描器的统一入口。
 * 将安全、无障碍、性能三大类规则扫描器的公开 API 集中导出。
 *
 * 在 Cheater 系统中的角色：
 *   代码生成管线的最后阶段（审计 / 装配）会使用这些规则引擎
 *   对 LLM 生成的代码进行静态质量检查。这些检查完全基于正则表达式
 *   和字符串匹配，不消耗任何 LLM token，因此被称为"零成本"规则。
 *
 * 导出的规则扫描器：
 *   - scanSecurity / hasBlockingIssues — 安全漏洞扫描（XSS、eval、innerHTML 等）
 *   - scanA11y — 无障碍合规扫描（缺少 alt、ARIA、label 等）
 *   - scanPerformance — 性能反模式扫描（内联对象、index key、整包导入等）
 */

export {
  scanSecurity,
  hasBlockingIssues,
  type SecurityIssue,
  type Severity,
} from './security-rules.js';
export { scanA11y, type A11yIssue } from './a11y-rules.js';
export { scanPerformance, type PerformanceIssue } from './performance-rules.js';
