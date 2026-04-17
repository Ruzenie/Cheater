/**
 * @file tools/shared/index.ts — 跨 Agent 共享工具
 *
 * 本文件定义了可在多个 Agent 之间共享的通用工具。
 * 这些工具不属于某个特定 Agent，而是服务于 Pipeline 的整体调度和质量控制。
 *
 * 在 Cheater 系统中的角色：
 *   - Orchestrator 使用 analyzeComplexity 决定任务的调度策略和模型等级
 *   - Orchestrator 使用 qualityGate 判定代码是否达到交付标准
 *
 * 提供的工具：
 *   1. analyzeComplexity — 基于关键词启发式分析需求复杂度（simple/medium/complex）
 *   2. qualityGate       — 根据审计评分和严重问题数判定质量是否达标
 */

import { tool } from 'ai';
import { z } from 'zod';

/**
 * analyzeComplexity — 需求复杂度分析工具。
 *
 * 基于关键词的启发式复杂度判断（不需要 LLM），用于 Orchestrator 的路由决策。
 * 根据需求中出现的关键词判断复杂度等级：
 *   - simple：按钮、文本、图标等简单组件
 *   - medium：表单、列表、卡片、导航等中等组件
 *   - complex：表格、拖拽、图表、编辑器等复杂组件
 *
 * 同时分析需求中隐含的 Agent 调度需求（设计/代码/审计），
 * 如果用户没有明确指定，默认执行全流程。
 *
 * @param requirement - 前端需求的自然语言描述
 * @returns 复杂度等级、Pipeline 配置、预估步骤数和建议文本
 */
export const analyzeComplexity = tool({
  description: '分析前端需求的类型和复杂度，用于决定调度哪些 Agent 以及使用哪个等级的模型',
  inputSchema: z.object({
    requirement: z.string().describe('前端需求描述'),
  }),
  execute: async ({ requirement }) => {
    // 基于关键词的启发式复杂度判断（不需要 LLM）
    // 三个级别的关键词列表，支持中英文双语匹配
    const complexitySignals = {
      simple: ['按钮', 'button', '文本', 'text', '图标', 'icon', '标签', 'badge', 'tag'],
      medium: [
        '表单',
        'form',
        '列表',
        'list',
        '卡片',
        'card',
        '导航',
        'nav',
        '模态',
        'modal',
        'dialog',
      ],
      complex: [
        '表格',
        'table',
        '拖拽',
        'drag',
        '动画',
        'animation',
        '图表',
        'chart',
        '编辑器',
        'editor',
        '实时',
        'realtime',
        'websocket',
        '虚拟滚动',
        'virtual',
        '无限滚动',
        'infinite',
      ],
    };

    // 将需求转为小写进行关键词匹配
    const lower = requirement.toLowerCase();
    let complexity: 'simple' | 'medium' | 'complex' = 'medium';

    // 优先匹配 complex（覆盖 medium），再尝试 simple
    if (complexitySignals.complex.some((s) => lower.includes(s))) {
      complexity = 'complex';
    } else if (complexitySignals.simple.some((s) => lower.includes(s))) {
      complexity = 'simple';
    }

    // 通过正则匹配判断需要哪些 Agent（设计/代码/审计）
    const needsDesign = /设计|布局|响应式|design|layout|responsive|样式|颜色|色彩/i.test(
      requirement,
    );
    const needsCode = /实现|开发|写|代码|组件|code|component|create|build|implement/i.test(
      requirement,
    );
    const needsAudit = /审计|检查|审查|review|audit|安全|性能|优化/i.test(requirement);

    // 如果需求中没有明确指定任何 Agent，默认执行全流程
    const pipeline =
      needsDesign || needsCode || needsAudit
        ? { design: needsDesign, code: needsCode, audit: needsAudit }
        : { design: true, code: true, audit: true };

    return {
      complexity,
      pipeline,
      estimatedSteps: complexity === 'simple' ? 5 : complexity === 'medium' ? 10 : 15,
      suggestion: `复杂度：${complexity}，建议执行：${Object.entries(pipeline)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(' → ')}`,
    };
  },
});

/**
 * qualityGate — 质量门禁工具。
 *
 * 根据审计结果 JSON 判定代码是否达到质量标准。
 * 判定条件：
 *   1. 评分 >= 阈值（threshold，默认 7 分）
 *   2. 零 critical 级别问题
 * 两个条件必须同时满足才算通过。
 *
 * @param auditResult - 审计结果的 JSON 字符串（来自 fullAuditTool 的输出）
 * @param threshold - 通过阈值，1-10 分制（默认 7）
 * @returns 通过状态、评分、建议文本
 */
export const qualityGate = tool({
  description: '根据审计结果判定代码是否达到质量标准，返回通过/不通过以及改进建议',
  inputSchema: z.object({
    auditResult: z.string().describe('审计结果 JSON 字符串'),
    threshold: z.number().default(7).describe('通过阈值（1-10）'),
  }),
  execute: async ({ auditResult, threshold }) => {
    try {
      // 尝试解析审计结果 JSON
      const audit = JSON.parse(auditResult);
      const score = audit.overallScore ?? 5;
      // 通过条件：评分 >= 阈值 且 零 critical 问题
      const passed = score >= threshold && (audit.summary?.critical ?? 0) === 0;

      return {
        passed,
        score,
        threshold,
        verdict: passed ? '✅ 质量达标' : '❌ 质量不达标',
        criticalIssues: audit.summary?.critical ?? 0,
        actionRequired: !passed,
        suggestion: passed
          ? '代码质量达标，可以交付。'
          : `需要修复 ${audit.summary?.critical ?? '?'} 个严重问题后重新审计。`,
      };
    } catch {
      // JSON 解析失败时返回不通过，提示需要重新执行审计
      return {
        passed: false,
        score: 0,
        threshold,
        verdict: '❌ 审计结果解析失败',
        criticalIssues: -1,
        actionRequired: true,
        suggestion: '审计结果格式异常，请重新执行审计。',
      };
    }
  },
});
