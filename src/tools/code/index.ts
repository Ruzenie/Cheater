/**
 * code tools — 代码生成相关工具集
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getCodeGenerator, listCodeGenerators } from '../../generators/index.js';

export const scaffoldComponent = tool({
  description: '根据组件规格与目标框架生成骨架文件集合，支持可插拔生成器架构',
  inputSchema: z.object({
    name: z.string().describe('组件名称 PascalCase'),
    props: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      defaultValue: z.string().optional(),
    })),
    hasChildren: z.boolean().default(false),
    framework: z.string().default('react').describe(`目标框架，可用值：${listCodeGenerators().map((generator) => generator.frameworkAliases[0]).join(', ')}`),
    styleMethod: z.string().default('tailwind').describe('样式方案，如 tailwind, css, css-modules 等'),
  }),
  execute: async ({ name, props, hasChildren, framework, styleMethod }) => {
    const generator = getCodeGenerator(framework);
    const artifacts = generator.createScaffold({
      name,
      description: `${name} 组件`,
      props: props.map((prop) => ({
        ...prop,
        description: '',
      })),
      children: hasChildren ? ['children'] : [],
      states: [],
      events: [],
    }, {
      framework,
      styleMethod,
      darkMode: false,
    });

    return {
      generator: generator.id,
      entryFileName: generator.getEntryArtifact(artifacts).fileName,
      artifacts,
      instruction: `已生成 ${generator.displayName} 骨架，请基于这些文件继续补全实现。`,
    };
  },
});

export const generateStyles = tool({
  description: '为组件生成样式代码（Tailwind 类名列表 / CSS / CSS Modules 等）',
  inputSchema: z.object({
    componentName: z.string(),
    styleMethod: z.string().describe('样式方案，如 tailwind, css-modules, css 等'),
    designTokens: z.object({
      primaryColor: z.string().optional(),
      borderRadius: z.string().optional(),
      spacing: z.string().optional(),
      fontSize: z.string().optional(),
    }).optional(),
    responsive: z.boolean().default(true),
    darkMode: z.boolean().default(false),
  }),
  execute: async ({ componentName, styleMethod, designTokens, responsive, darkMode }) => {
    return {
      componentName,
      styleMethod,
      designTokens: designTokens ?? {},
      responsive,
      darkMode,
      instruction: `为 ${componentName} 生成${styleMethod}样式代码。${responsive ? ' 包含响应式断点。' : ''}${darkMode ? ' 包含暗色模式样式。' : ''}`,
    };
  },
});

export const addInteractions = tool({
  description: '为组件添加交互逻辑（点击、hover、表单校验、动画、键盘操作等）',
  inputSchema: z.object({
    componentCode: z.string().describe('当前组件代码或文件内容'),
    interactions: z.array(z.object({
      type: z.enum(['click', 'hover', 'scroll', 'form-validation', 'animation', 'keyboard', 'drag']),
      description: z.string().describe('交互行为描述'),
      targetElement: z.string().optional(),
    })),
  }),
  execute: async ({ componentCode, interactions }) => {
    const interactionSummary = interactions
      .map((interaction, index) => `${index + 1}. [${interaction.type}] ${interaction.description}${interaction.targetElement ? ` (on ${interaction.targetElement})` : ''}`)
      .join('\n');

    return {
      currentCode: componentCode,
      instruction: `在以下代码中补充交互逻辑：\n\n${componentCode}\n\n需要添加的交互：\n${interactionSummary}`,
    };
  },
});

export const selfReview = tool({
  description: '对生成代码进行静态自检，返回问题清单',
  inputSchema: z.object({
    code: z.string(),
    checks: z.array(z.enum(['typescript', 'error-handling', 'naming', 'structure'])).default(['typescript', 'error-handling', 'naming', 'structure']),
  }),
  execute: async ({ code, checks }) => {
    const issues: Array<{ check: string; severity: string; message: string }> = [];

    if (checks.includes('typescript')) {
      if (!code.includes('interface') && !code.includes('type ')) {
        issues.push({ check: 'typescript', severity: 'warning', message: '缺少类型定义' });
      }
      if (/:\s*any\b/.test(code)) {
        issues.push({ check: 'typescript', severity: 'warning', message: '存在 any 类型，应使用具体类型' });
      }
    }

    if (checks.includes('error-handling')) {
      if (code.includes('fetch(') && !code.includes('catch')) {
        issues.push({ check: 'error-handling', severity: 'critical', message: 'fetch 调用缺少错误处理' });
      }
      if (code.includes('async') && !code.includes('try')) {
        issues.push({ check: 'error-handling', severity: 'warning', message: '异步操作缺少 try-catch' });
      }
    }

    if (checks.includes('naming')) {
      const singleLetterVars = code.match(/(?:const|let|var)\s+([a-z])\s*=/g) ?? [];
      if (singleLetterVars.length > 0) {
        issues.push({ check: 'naming', severity: 'info', message: `存在单字母变量名：${singleLetterVars.join(', ')}` });
      }
    }

    if (checks.includes('structure')) {
      const lines = code.split('\n').length;
      if (lines > 200) {
        issues.push({ check: 'structure', severity: 'warning', message: `文件过长 (${lines} 行)，建议拆分` });
      }
    }

    return {
      passed: issues.filter((issue) => issue.severity === 'critical').length === 0,
      totalIssues: issues.length,
      issues,
    };
  },
});
