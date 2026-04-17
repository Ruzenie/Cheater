/**
 * code-auditor.ts — 代码审计 Agent（v3 — 流式输出 + 宽松解析 + Telemetry）
 *
 * 职责：
 *   在 Code Producer 产出组件代码之后运行，对合并后的代码进行质量审计。
 *   采用"静态规则引擎 + LLM 深度分析"两阶段策略，既保证基础覆盖（零成本），
 *   又能发现规则引擎无法捕获的架构级/逻辑级问题。
 *
 * 审计流程（3 个 Phase）：
 *   Phase 1 — 静态规则扫描（零 LLM 成本）
 *     调用三个规则引擎（security / a11y / performance），用正则 + AST 匹配
 *     检出安全漏洞（XSS、eval）、无障碍问题（缺少 alt、ARIA）、性能反模式等。
 *     根据 critical / warning / info 计算基础评分（满分 10）。
 *
 *   Phase 2 — LLM 深度分析（reasoner 模型）
 *     将代码发给 reasoner 模型做架构审查、边界条件、可维护性、业务风险分析。
 *     输出结构化 JSON（architectureNotes / improvementSuggestions / riskAssessment）。
 *     可通过 skipDeepAnalysis 跳过（用于组装后的轻量审计）。
 *
 *   Phase 3 — 报告摘要生成（executor 模型）
 *     将评分和扫描统计发给 executor 模型，生成一段不超过 200 字的中文总结。
 *     Phase 2 和 Phase 3 通过 Promise.all 并行执行，节省时间。
 *
 * 模型策略：
 *   - 规则扫描 → 零成本（纯代码，不调用 LLM）
 *   - 深度分析 → reasoner（需要强推理判断架构和逻辑问题）
 *   - 报告生成 → executor（模板化总结，低成本模型即可）
 *
 * 评分算法：
 *   基础分 10 分，每个 critical 扣 2 分，每个 warning 扣 0.5 分，下限 0 分。
 *   最终 passed = (score >= threshold) && (critical === 0)
 *
 * 在 Orchestrator 中的位置：
 *   - Step 5: 主审计（可能触发 Code Producer 重新生成，最多 3 轮）
 *   - Step 7: 组装后轻量审计（skipDeepAnalysis: true）
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

/**
 * 审计最终输出结构，由 Orchestrator 消费。
 *
 * - overallScore: 0-10 的质量评分（由静态扫描计算）
 * - passed: 是否通过审计（score >= threshold && critical === 0）
 * - staticScan: 三个维度的规则扫描结果
 * - deepAnalysis: LLM 深度分析结果（如果 skipDeepAnalysis 则为空占位）
 * - summary: 面向人类的审计摘要文本
 */
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

// ── Zod Schema ──────────────────────────────────────

/**
 * LLM 深度分析输出的 schema。
 * 使用 optional + default 做宽松解析——LLM 可能漏掉某些字段。
 */
const DeepAnalysisSchema = z.object({
  /** 架构层面的观察（如组件职责是否清晰、依赖是否合理） */
  architectureNotes: z.array(z.string()).describe('架构层面的观察').optional().default([]),
  /** 具体的改进建议（如边界条件处理、性能优化点） */
  improvementSuggestions: z.array(z.string()).describe('具体的改进建议').optional().default([]),
  /** 综合风险评估（一段话总结整体风险水平） */
  riskAssessment: z.string().describe('风险评估总结'),
});

/**
 * LLM 审计摘要输出的 schema。
 * summary 是给人看的一段中文总结，highlights 是 1-3 条关键发现。
 */
const AuditSummarySchema = z.object({
  /** 审计总结，不超过 200 字 */
  summary: z.string().describe('审计总结，不超过 200 字'),
  /** 关键发现列表，方便快速浏览 */
  highlights: z.array(z.string()).describe('关键发现（1-3 条）').optional().default([]),
});

// ── Telemetry 配置 ──────────────────────────────────

/** 为每个 LLM 调用生成统一的 telemetry 配置 */
function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 纯函数：执行完整静态扫描（直接调用规则引擎，零 LLM 成本）──

/**
 * 对合并后的代码文本执行三维度静态扫描：安全 / 无障碍 / 性能。
 *
 * 评分算法：
 *   - 基础分 10 分
 *   - 每个 critical 级别问题扣 2 分
 *   - 每个 warning 级别问题扣 0.5 分
 *   - info 级别不扣分
 *   - 最终评分 clamp 到 [0, 10]
 *
 * @param code - 合并后的代码文本（通常是所有组件的 HTML/CSS/JS 拼接）
 * @returns 评分、通过状态、各维度详情
 */
function runFullStaticScan(code: string) {
  // 调用三个规则引擎（纯正则匹配，不调用 LLM）
  const security = scanSecurity(code);
  const a11y = scanA11y(code);
  const performance = scanPerformance(code);

  // 按严重程度统计问题数量
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

  // 计算评分：满分 10，critical 扣 2，warning 扣 0.5
  const deductions = totalCritical * 2 + totalWarnings * 0.5;
  const score = Math.max(0, Math.min(10, 10 - deductions));

  return {
    /** 0-10 的质量评分，保留一位小数 */
    overallScore: Math.round(score * 10) / 10,
    /** 是否通过：没有 critical 级别问题 */
    passed: totalCritical === 0,
    /** 各严重程度的问题计数 */
    summary: { critical: totalCritical, warnings: totalWarnings, info: totalInfo },
    /** 三个维度的详细扫描结果 */
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

/**
 * 运行代码审计 Agent。
 *
 * 执行流程：
 *   1. Phase 1: 静态规则扫描（零 LLM 成本）
 *   2. Phase 2+3: LLM 深度分析 + 报告生成（并行流式，可跳过深度分析）
 *
 * @param code - 待审计的代码文本（通常是所有组件代码的合并文本）
 * @param providers - 三层模型 Provider（executor / worker / reasoner）
 * @param options.framework - 框架类型（影响深度分析的 prompt 上下文，默认 'react'）
 * @param options.skipDeepAnalysis - 是否跳过 LLM 深度分析（组装后轻量审计时设为 true）
 * @param options.qualityThreshold - 通过阈值（默认 7/10），低于此分数视为不通过
 * @returns AuditOutput — 评分、通过状态、扫描详情、深度分析、摘要
 */
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
  // 调用三个纯正则规则引擎，不消耗任何 token
  console.log('   📋 Phase 1: 静态规则扫描 (零成本)...');
  const staticResult = runFullStaticScan(code);

  console.log(
    `   ✅ 静态扫描完成 | 评分: ${staticResult.overallScore}/10 | ` +
      `critical: ${staticResult.summary.critical} | warnings: ${staticResult.summary.warnings}`,
  );

  // ── Phase 2 + 3: 深度分析 + 报告生成（⚡ 并行流式）──

  // 深度分析的默认值（跳过时使用）
  let deepAnalysis: AuditOutput['deepAnalysis'] = {
    architectureNotes: [],
    improvementSuggestions: [],
    riskAssessment: '跳过了深度分析',
  };
  let summary = '审计完成';

  // 报告生成的 prompt（Phase 3 始终需要，无论是否跳过深度分析）
  const summaryPrompt = `根据以下审计数据生成总结：

评分：${staticResult.overallScore}/10
静态扫描：critical ${staticResult.summary.critical} 个，warning ${staticResult.summary.warnings} 个
通过阈值：${qualityThreshold}/10
是否通过：${staticResult.overallScore >= qualityThreshold && staticResult.summary.critical === 0 ? '通过' : '不通过'}`;

  if (!skipDeepAnalysis) {
    // ── 完整审计模式：Phase 2（深度分析）+ Phase 3（报告摘要）并行执行 ──
    console.log('   🧠📝 Phase 2+3: 深度分析 & 报告生成（并行流式）...');

    // Phase 2: 启动 reasoner 模型进行深度分析流
    // 重点分析规则引擎无法覆盖的问题：架构合理性、边界条件、可维护性、业务风险
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

    // Phase 3: 启动 executor 模型生成审计摘要流
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

    // ⚡ 并行等待两个流完成（减少总耗时）
    const [analysisText, summaryText] = await Promise.all([
      consumeTextStream(analysisStream.textStream, { prefix: '      [analysis] ', echo: false }),
      consumeTextStream(summaryStream.textStream, { prefix: '      [summary] ', echo: false }),
    ]);

    // 宽松解析深度分析结果
    // 策略：先 zod safeParse → 失败则手动提取字段 → 再失败则用原始文本截断
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
      // JSON 解析完全失败，用原始文本前 300 字作为 fallback
      deepAnalysis = {
        architectureNotes: [],
        improvementSuggestions: [],
        riskAssessment: analysisText.slice(0, 300),
      };
    }

    // 宽松解析报告摘要
    // 策略同上：zod safeParse → 手动提取 → 原始文本截断
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
    // ── 轻量审计模式：跳过 Phase 2，只生成 Phase 3 报告摘要 ──
    // 用于组装后的 Final Audit（Step 7），不需要深度分析
    console.log('   ⏭️  Phase 2: 跳过深度分析');

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

    // 宽松解析报告摘要（同完整模式的解析逻辑）
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

  // ── 计算最终通过状态 ──
  // 必须同时满足：评分 >= 阈值 AND 没有 critical 级别问题
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
