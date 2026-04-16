/**
 * code-auditor.ts — 代码审计 Agent（v3 — 流式输出 + 宽松解析 + Telemetry）
 *
 * 优化点：
 *   1. 全部改为 streamText 流式输出
 *   2. Phase 2 + Phase 3 并行执行
 *   3. 集成 experimental_telemetry 追踪
 *   4. 手动 JSON 解析 + zod safeParse（兼容第三方模型）
 *
 * 模型策略：
 *   - 规则扫描 → 零成本（纯代码）
 *   - 深度分析 → reasoner（需要强推理判断）
 *   - 报告生成 → executor（模板化总结）
 */

import { streamText } from 'ai';
import { z } from 'zod';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import { scanSecurity, hasBlockingIssues, type SecurityIssue } from '../rules/security-rules.js';
import { scanA11y, type A11yIssue } from '../rules/a11y-rules.js';
import { scanPerformance, type PerformanceIssue } from '../rules/performance-rules.js';

// ── 输出类型 ──────────────────────────────────────────

export interface AuditOutput {
  overallScore: number;
  passed: boolean;
  staticScan: {
    security: { passed: boolean; issues: SecurityIssue[] };
    a11y: { passed: boolean; issues: A11yIssue[] };
    performance: { passed: boolean; issues: PerformanceIssue[] };
  };
  deepAnalysis: {
    architectureNotes: string[];
    improvementSuggestions: string[];
    riskAssessment: string;
  };
  summary: string;
}

// ── Schema ──

const DeepAnalysisSchema = z.object({
  architectureNotes: z.array(z.string()).describe('架构层面的观察').optional().default([]),
  improvementSuggestions: z.array(z.string()).describe('具体的改进建议').optional().default([]),
  riskAssessment: z.string().describe('风险评估总结'),
});

const AuditSummarySchema = z.object({
  summary: z.string().describe('审计总结，不超过 200 字'),
  highlights: z.array(z.string()).describe('关键发现（1-3 条）').optional().default([]),
});

// ── Telemetry 配置 ──

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 纯函数：执行完整静态扫描（直接调用规则引擎）──

function runFullStaticScan(code: string) {
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

  const totalInfo =
    security.filter((i) => i.severity === 'info').length +
    a11y.filter((i) => i.severity === 'info').length +
    performance.filter((i) => i.severity === 'info').length;

  const deductions = totalCritical * 2 + totalWarnings * 0.5;
  const score = Math.max(0, Math.min(10, 10 - deductions));

  return {
    overallScore: Math.round(score * 10) / 10,
    passed: totalCritical === 0,
    summary: { critical: totalCritical, warnings: totalWarnings, info: totalInfo },
    details: {
      security: { issues: security, passed: !hasBlockingIssues(security) },
      a11y: { issues: a11y, passed: a11y.filter((i) => i.severity === 'critical').length === 0 },
      performance: {
        issues: performance,
        passed: performance.filter((i) => i.severity === 'critical').length === 0,
      },
    },
  };
}

// ── Agent 主函数 ──────────────────────────────────────

export async function runCodeAuditor(
  code: string,
  providers: AllProviders,
  options: {
    framework?: string;
    skipDeepAnalysis?: boolean;
    qualityThreshold?: number;
  } = {},
): Promise<AuditOutput> {
  const { framework = 'react', skipDeepAnalysis = false, qualityThreshold = 7 } = options;

  console.log('\n🔍 [Audit Agent] 开始审计...');

  // ── Phase 1: 静态规则扫描（零 LLM 成本）──
  console.log('   📋 Phase 1: 静态规则扫描 (零成本)...');
  const staticResult = runFullStaticScan(code);

  console.log(
    `   ✅ 静态扫描完成 | 评分: ${staticResult.overallScore}/10 | ` +
      `critical: ${staticResult.summary.critical} | warnings: ${staticResult.summary.warnings}`,
  );

  // ── Phase 2 + 3: 深度分析 + 报告生成（⚡ 并行流式）──

  let deepAnalysis: AuditOutput['deepAnalysis'] = {
    architectureNotes: [],
    improvementSuggestions: [],
    riskAssessment: '跳过了深度分析',
  };
  let summary = '审计完成';

  const summaryPrompt = `根据以下审计数据生成总结：

评分：${staticResult.overallScore}/10
静态扫描：critical ${staticResult.summary.critical} 个，warning ${staticResult.summary.warnings} 个
通过阈值：${qualityThreshold}/10
是否通过：${staticResult.overallScore >= qualityThreshold && staticResult.summary.critical === 0 ? '通过' : '不通过'}`;

  if (!skipDeepAnalysis) {
    console.log('   🧠📝 Phase 2+3: 深度分析 & 报告生成（并行流式）...');

    // 启动两个流
    const analysisStream = streamText({
      model: getWrappedModel('reasoner', providers),
      system: `你是一个高级前端代码审计专家（${framework}）。
你的任务是做规则引擎无法覆盖的深度分析，重点关注：
1. 架构合理性（组件职责划分、依赖关系）
2. 边界条件处理（竞态、内存泄漏、异常路径）
3. 可维护性（代码可读性、扩展性）
4. 实际业务风险（逻辑漏洞、数据一致性）

规则引擎已检出的问题（不需要重复）：
${JSON.stringify(staticResult.summary)}

你必须输出合法的 JSON，格式如下：
{
  "architectureNotes": ["观察1", "观察2"],
  "improvementSuggestions": ["建议1", "建议2"],
  "riskAssessment": "风险评估总结"
}

不要输出任何 JSON 以外的内容。`,
      prompt: `请深度分析以下代码：\n\n${code}`,
      temperature: 0.2,
      experimental_telemetry: telemetryConfig('code-auditor:deep-analysis'),
    });

    const summaryStream = streamText({
      model: getWrappedModel('executor', providers),
      system: `你是一个代码审计报告撰写专家。用简洁的中文生成审计总结。

你必须输出合法的 JSON，格式如下：
{
  "summary": "审计总结文字",
  "highlights": ["关键发现1", "关键发现2"]
}

不要输出任何 JSON 以外的内容。`,
      prompt: summaryPrompt,
      temperature: 0.3,
      maxOutputTokens: 1000,
      experimental_telemetry: telemetryConfig('code-auditor:summary'),
    });

    // 并行等待
    const [analysisText, summaryText] = await Promise.all([
      consumeTextStream(analysisStream.textStream, { prefix: '      [analysis] ', echo: false }),
      consumeTextStream(summaryStream.textStream, { prefix: '      [summary] ', echo: false }),
    ]);

    // 宽松解析深度分析
    try {
      const rawAnalysis = safeParseJson(analysisText) as Record<string, unknown>;
      const parsed = DeepAnalysisSchema.safeParse(rawAnalysis);
      deepAnalysis = parsed.success
        ? parsed.data
        : {
            architectureNotes: (rawAnalysis.architectureNotes as string[]) ?? [],
            improvementSuggestions: (rawAnalysis.improvementSuggestions as string[]) ?? [],
            riskAssessment:
              (typeof rawAnalysis.riskAssessment === 'string'
                ? rawAnalysis.riskAssessment
                : undefined) ?? analysisText.slice(0, 300),
          };
    } catch {
      deepAnalysis = {
        architectureNotes: [],
        improvementSuggestions: [],
        riskAssessment: analysisText.slice(0, 300),
      };
    }

    // 宽松解析报告
    try {
      const rawSummary = safeParseJson(summaryText) as Record<string, unknown>;
      const parsed = AuditSummarySchema.safeParse(rawSummary);
      summary = parsed.success
        ? parsed.data.summary
        : ((typeof rawSummary.summary === 'string' ? rawSummary.summary : undefined) ??
            summaryText.slice(0, 200));
    } catch {
      summary = summaryText.slice(0, 200);
    }

    console.log(`   ✅ 深度分析完成 | ${deepAnalysis.improvementSuggestions.length} 条改进建议`);
    console.log(`   ✅ 报告生成完成`);
  } else {
    console.log('   ⏭️  Phase 2: 跳过深度分析');

    // 只生成报告
    console.log('   📝 Phase 3: 生成审计报告 (executor)...');
    const summaryStream = streamText({
      model: getWrappedModel('executor', providers),
      system: `你是一个代码审计报告撰写专家。用简洁的中文生成审计总结。

你必须输出合法的 JSON，格式如下：
{
  "summary": "审计总结文字",
  "highlights": ["关键发现1", "关键发现2"]
}

不要输出任何 JSON 以外的内容。`,
      prompt: summaryPrompt,
      temperature: 0.3,
      maxOutputTokens: 1000,
      experimental_telemetry: telemetryConfig('code-auditor:summary'),
    });

    const summaryText = await consumeTextStream(summaryStream.textStream, {
      prefix: '      [summary] ',
      echo: false,
    });
    try {
      const rawSummary = safeParseJson(summaryText) as Record<string, unknown>;
      const parsed = AuditSummarySchema.safeParse(rawSummary);
      summary = parsed.success
        ? parsed.data.summary
        : ((typeof rawSummary.summary === 'string' ? rawSummary.summary : undefined) ??
            summaryText.slice(0, 200));
    } catch {
      summary = summaryText.slice(0, 200);
    }
  }

  const passed =
    staticResult.overallScore >= qualityThreshold && staticResult.summary.critical === 0;

  console.log(
    `\n🔍 [Audit Agent] 审计完成！评分: ${staticResult.overallScore}/10 ${passed ? '✅ 通过' : '❌ 不通过'}\n`,
  );

  return {
    overallScore: staticResult.overallScore,
    passed,
    staticScan: staticResult.details,
    deepAnalysis,
    summary,
  };
}
