/**
 * shared tools — 跨 Agent 共享工具
 */

import { tool } from 'ai';
import { z } from 'zod';

/**
 * 需求复杂度分析工具 — 用于 Orchestrator 路由决策
 */
export const analyzeComplexity = tool({
  description: '分析前端需求的类型和复杂度，用于决定调度哪些 Agent 以及使用哪个等级的模型',
  inputSchema: z.object({
    requirement: z.string().describe('前端需求描述'),
  }),
  execute: async ({ requirement }) => {
    // 基于关键词的启发式复杂度判断（不需要 LLM）
    const complexitySignals = {
      simple: ['按钮', 'button', '文本', 'text', '图标', 'icon', '标签', 'badge', 'tag'],
      medium: ['表单', 'form', '列表', 'list', '卡片', 'card', '导航', 'nav', '模态', 'modal', 'dialog'],
      complex: ['表格', 'table', '拖拽', 'drag', '动画', 'animation', '图表', 'chart', '编辑器', 'editor',
                '实时', 'realtime', 'websocket', '虚拟滚动', 'virtual', '无限滚动', 'infinite'],
    };

    const lower = requirement.toLowerCase();
    let complexity: 'simple' | 'medium' | 'complex' = 'medium';

    if (complexitySignals.complex.some((s) => lower.includes(s))) {
      complexity = 'complex';
    } else if (complexitySignals.simple.some((s) => lower.includes(s))) {
      complexity = 'simple';
    }

    // 判断需要哪些 Agent
    const needsDesign = /设计|布局|响应式|design|layout|responsive|样式|颜色|色彩/i.test(requirement);
    const needsCode = /实现|开发|写|代码|组件|code|component|create|build|implement/i.test(requirement);
    const needsAudit = /审计|检查|审查|review|audit|安全|性能|优化/i.test(requirement);

    // 如果啥都没明确说，默认全流程
    const pipeline = needsDesign || needsCode || needsAudit
      ? { design: needsDesign, code: needsCode, audit: needsAudit }
      : { design: true, code: true, audit: true };

    return {
      complexity,
      pipeline,
      estimatedSteps: complexity === 'simple' ? 5 : complexity === 'medium' ? 10 : 15,
      suggestion: `复杂度：${complexity}，建议执行：${
        Object.entries(pipeline)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(' → ')
      }`,
    };
  },
});

/**
 * 质量门禁工具 — 判定是否达标
 */
export const qualityGate = tool({
  description: '根据审计结果判定代码是否达到质量标准，返回通过/不通过以及改进建议',
  inputSchema: z.object({
    auditResult: z.string().describe('审计结果 JSON 字符串'),
    threshold: z.number().default(7).describe('通过阈值（1-10）'),
  }),
  execute: async ({ auditResult, threshold }) => {
    try {
      const audit = JSON.parse(auditResult);
      const score = audit.overallScore ?? 5;
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
