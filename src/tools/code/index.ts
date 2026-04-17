/**
 * @file tools/code/index.ts — 代码生成相关工具集
 *
 * 本文件定义了 Code Producer Agent 使用的代码生成工具。
 * 通过可插拔的生成器架构（generators），支持 React / Vue / Svelte / Vanilla 等多种框架。
 *
 * 在 Cheater Pipeline 中的位置：
 *   需求精炼 → 设计分析 → 项目规划 → **代码生成** → 代码审计 → 代码组装
 *
 * 提供的工具：
 *   1. scaffoldComponent — 根据组件规格生成骨架文件（利用可插拔生成器）
 *   2. generateStyles   — 为组件生成样式代码（Tailwind / CSS / CSS Modules 等）
 *   3. addInteractions  — 为组件添加交互逻辑（点击、hover、表单校验、动画等）
 *   4. selfReview       — 对生成代码进行静态自检（类型、错误处理、命名、结构）
 *
 * 工具内部使用 `../../generators/` 提供的代码生成器完成骨架生成，
 * 其余工具主要负责格式化指令文本供 LLM 在后续步骤中补全实现。
 */

import { tool } from 'ai';
import { z } from 'zod';
// 导入可插拔代码生成器系统 —— 支持 React / Vue / Svelte / Vanilla 等框架
import { getCodeGenerator, listCodeGenerators } from '../../generators/index.js';

/**
 * scaffoldComponent — 根据组件规格与目标框架生成骨架文件集合。
 *
 * 利用可插拔的生成器架构（generators），为指定框架生成组件的初始骨架代码。
 * 骨架包含类型定义、Props 接口、基础组件结构等，供 LLM 在后续步骤中补全具体实现。
 *
 * @param name - 组件名称（PascalCase）
 * @param props - 组件的 Props 定义列表
 * @param hasChildren - 是否接受子元素（默认 false）
 * @param framework - 目标框架（默认 'react'，可选值由注册的生成器决定）
 * @param styleMethod - 样式方案（默认 'tailwind'）
 * @returns 生成器信息、入口文件名和骨架文件列表
 */
export const scaffoldComponent = tool({
  description: '根据组件规格与目标框架生成骨架文件集合，支持可插拔生成器架构',
  inputSchema: z.object({
    name: z.string().describe('组件名称 PascalCase'),
    props: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        required: z.boolean(),
        defaultValue: z.string().optional(),
      }),
    ),
    hasChildren: z.boolean().default(false),
    framework: z
      .string()
      .default('react')
      .describe(
        `目标框架，可用值：${listCodeGenerators()
          .map((generator) => generator.frameworkAliases[0])
          .join(', ')}`,
      ),
    styleMethod: z
      .string()
      .default('tailwind')
      .describe('样式方案，如 tailwind, css, css-modules 等'),
  }),
  execute: async ({ name, props, hasChildren, framework, styleMethod }) => {
    // 根据框架名获取对应的代码生成器实例
    const generator = getCodeGenerator(framework);
    // 调用生成器创建骨架代码（包含组件文件、样式文件等）
    const artifacts = generator.createScaffold(
      {
        name,
        description: `${name} 组件`,
        // 补全 props 中缺少的 description 字段
        props: props.map((prop) => ({
          ...prop,
          description: '',
        })),
        children: hasChildren ? ['children'] : [],
        states: [],
        events: [],
      },
      {
        framework,
        styleMethod,
        darkMode: false,
      },
    );

    return {
      generator: generator.id,
      entryFileName: generator.getEntryArtifact(artifacts).fileName,
      artifacts,
      instruction: `已生成 ${generator.displayName} 骨架，请基于这些文件继续补全实现。`,
    };
  },
});

/**
 * generateStyles — 为组件生成样式代码。
 *
 * 根据组件名、样式方案和设计令牌（design tokens），生成对应的样式代码。
 * 支持 Tailwind 类名列表、CSS、CSS Modules 等多种样式方案。
 * 可选包含响应式断点和暗色模式样式。
 *
 * 注意：本工具仅格式化样式生成指令，实际样式代码由 LLM 生成。
 *
 * @param componentName - 组件名称
 * @param styleMethod - 样式方案（tailwind / css-modules / css 等）
 * @param designTokens - 设计令牌（颜色、圆角、间距、字号等，可选）
 * @param responsive - 是否包含响应式断点（默认 true）
 * @param darkMode - 是否包含暗色模式样式（默认 false）
 * @returns 格式化的样式生成指令
 */
export const generateStyles = tool({
  description: '为组件生成样式代码（Tailwind 类名列表 / CSS / CSS Modules 等）',
  inputSchema: z.object({
    componentName: z.string(),
    styleMethod: z.string().describe('样式方案，如 tailwind, css-modules, css 等'),
    designTokens: z
      .object({
        primaryColor: z.string().optional(),
        borderRadius: z.string().optional(),
        spacing: z.string().optional(),
        fontSize: z.string().optional(),
      })
      .optional(),
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

/**
 * addInteractions — 为组件添加交互逻辑。
 *
 * 接收当前组件代码和需要添加的交互行为列表，
 * 格式化为结构化的指令供 LLM 在代码中补充交互实现。
 * 支持的交互类型：click / hover / scroll / form-validation / animation / keyboard / drag
 *
 * @param componentCode - 当前组件的代码或文件内容
 * @param interactions - 需要添加的交互行为列表（类型 + 描述 + 目标元素）
 * @returns 包含当前代码和格式化交互指令的结构
 */
export const addInteractions = tool({
  description: '为组件添加交互逻辑（点击、hover、表单校验、动画、键盘操作等）',
  inputSchema: z.object({
    componentCode: z.string().describe('当前组件代码或文件内容'),
    interactions: z.array(
      z.object({
        type: z.enum([
          'click',
          'hover',
          'scroll',
          'form-validation',
          'animation',
          'keyboard',
          'drag',
        ]),
        description: z.string().describe('交互行为描述'),
        targetElement: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ componentCode, interactions }) => {
    // 将交互列表格式化为编号清单，方便 LLM 理解和执行
    const interactionSummary = interactions
      .map(
        (interaction, index) =>
          `${index + 1}. [${interaction.type}] ${interaction.description}${interaction.targetElement ? ` (on ${interaction.targetElement})` : ''}`,
      )
      .join('\n');

    return {
      currentCode: componentCode,
      instruction: `在以下代码中补充交互逻辑：\n\n${componentCode}\n\n需要添加的交互：\n${interactionSummary}`,
    };
  },
});

/**
 * selfReview — 对生成的代码进行静态自检。
 *
 * Code Producer 在生成代码后调用此工具进行自我质量检查。
 * 基于简单的正则匹配和启发式规则，不依赖 LLM。
 *
 * 支持的检查项：
 *   - typescript：类型定义是否完整、是否使用了 any 类型
 *   - error-handling：异步操作是否有错误处理
 *   - naming：是否存在单字母变量名
 *   - structure：文件是否过长（超过 200 行建议拆分）
 *
 * @param code - 待检查的代码字符串
 * @param checks - 要执行的检查项列表（默认全选）
 * @returns 检查结果，包含通过状态和详细问题列表
 */
export const selfReview = tool({
  description: '对生成代码进行静态自检，返回问题清单',
  inputSchema: z.object({
    code: z.string(),
    checks: z
      .array(z.enum(['typescript', 'error-handling', 'naming', 'structure']))
      .default(['typescript', 'error-handling', 'naming', 'structure']),
  }),
  execute: async ({ code, checks }) => {
    const issues: Array<{ check: string; severity: string; message: string }> = [];

    // ── TypeScript 类型检查 ──
    if (checks.includes('typescript')) {
      // 检查是否缺少类型定义（interface 或 type）
      if (!code.includes('interface') && !code.includes('type ')) {
        issues.push({ check: 'typescript', severity: 'warning', message: '缺少类型定义' });
      }
      // 检查是否使用了宽泛的 any 类型
      if (/:\s*any\b/.test(code)) {
        issues.push({
          check: 'typescript',
          severity: 'warning',
          message: '存在 any 类型，应使用具体类型',
        });
      }
    }

    // ── 错误处理检查 ──
    if (checks.includes('error-handling')) {
      // 检查 fetch 调用是否缺少 catch 错误处理
      if (code.includes('fetch(') && !code.includes('catch')) {
        issues.push({
          check: 'error-handling',
          severity: 'critical',
          message: 'fetch 调用缺少错误处理',
        });
      }
      // 检查异步函数是否缺少 try-catch
      if (code.includes('async') && !code.includes('try')) {
        issues.push({
          check: 'error-handling',
          severity: 'warning',
          message: '异步操作缺少 try-catch',
        });
      }
    }

    // ── 命名规范检查 ──
    if (checks.includes('naming')) {
      // 匹配单字母变量名（如 const a = ...），不利于代码可读性
      const singleLetterVars = code.match(/(?:const|let|var)\s+([a-z])\s*=/g) ?? [];
      if (singleLetterVars.length > 0) {
        issues.push({
          check: 'naming',
          severity: 'info',
          message: `存在单字母变量名：${singleLetterVars.join(', ')}`,
        });
      }
    }

    // ── 文件结构检查 ──
    if (checks.includes('structure')) {
      // 检查文件行数是否过多（超过 200 行建议拆分为多个文件）
      const lines = code.split('\n').length;
      if (lines > 200) {
        issues.push({
          check: 'structure',
          severity: 'warning',
          message: `文件过长 (${lines} 行)，建议拆分`,
        });
      }
    }

    return {
      passed: issues.filter((issue) => issue.severity === 'critical').length === 0,
      totalIssues: issues.length,
      issues,
    };
  },
});
