/**
 * @file tools/design/index.ts — 设计分析相关工具集
 *
 * 本文件定义了 Design Analyzer Agent 使用的设计分析工具，
 * 以及贯穿整个 Pipeline 的核心数据结构 —— ComponentSpec（组件规格）。
 *
 * 在 Cheater Pipeline 中的位置：
 *   需求精炼 → **设计分析** → 项目规划 → 代码生成 → 代码审计 → 代码组装
 *
 * 提供的工具：
 *   1. decomposeRequirement   — 将自然语言需求拆解为组件树
 *   2. planResponsiveStrategy — 为组件推荐响应式布局策略
 *   3. planStateManagement    — 分析组件树的状态管理需求
 *
 * 导出的类型：
 *   - ComponentSpecSchema — Zod schema，定义组件规格的完整结构
 *   - ComponentSpec       — TypeScript 类型，从 Zod schema 推导
 *
 * 注意：这些工具本身不调用 LLM，只负责收集和格式化输入。
 * LLM 的实际调用由 Agent 的主循环（generateText / streamText）驱动。
 */

import { tool } from 'ai';
import { z } from 'zod';

// ── 组件规格 Schema（贯穿整个 Pipeline 的核心数据结构）──
// ComponentSpec 是 Cheater 系统中最重要的数据结构之一，
// 它在设计分析、代码生成、项目规划等多个阶段之间传递组件信息。

/**
 * ComponentSpecSchema — 组件规格的 Zod Schema 定义。
 *
 * 描述一个前端组件的完整规格信息：
 *   - name: 组件名称（PascalCase）
 *   - description: 组件职责描述
 *   - props: 组件属性列表（名称、类型、是否必需、默认值、描述）
 *   - children: 子组件名称列表
 *   - states: 组件内部状态列表
 *   - events: 组件对外发出的事件列表
 *
 * 在 Pipeline 中的流转路径：
 *   Design Analyzer 输出 → Code Producer 输入 → Code Assembler 参考
 */
export const ComponentSpecSchema = z.object({
  name: z.string().describe('组件名称，PascalCase'),
  description: z.string().describe('组件职责描述'),
  props: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        required: z.boolean().optional().default(false),
        defaultValue: z.string().optional(),
        description: z.string().optional().default(''),
      }),
    )
    .optional()
    .default([]),
  children: z.array(z.string()).describe('子组件名称列表').optional().default([]),
  states: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        description: z.string().optional().default(''),
      }),
    )
    .describe('内部状态')
    .optional()
    .default([]),
  events: z
    .array(
      z.object({
        name: z.string(),
        payload: z.string().optional().default('void'),
        description: z.string().optional().default(''),
      }),
    )
    .describe('对外事件')
    .optional()
    .default([]),
});

/** 从 Zod Schema 推导出的 TypeScript 类型，供代码中类型安全地使用 */
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

// ── AI SDK 工具定义 ──────────────────────────────────────

/**
 * decomposeRequirement — 需求拆解工具。
 *
 * 将自然语言的前端需求描述拆解为结构化的组件树。
 * 本工具本身不调用 LLM，只负责收集输入并格式化为结构化指令。
 * LLM 调用由 Agent 的主循环（generateText/streamText）负责。
 *
 * @param requirement - 前端需求的自然语言描述
 * @param framework - 前端框架（默认 'react'）
 * @param styleSystem - 样式方案（默认 'tailwind'）
 * @returns 格式化的拆解指令，供 LLM 输出组件树 JSON
 */
export const decomposeRequirement = tool({
  description: '将前端需求拆解为组件树结构，输出每个组件的名称、职责和层级关系',
  inputSchema: z.object({
    requirement: z.string().describe('前端需求描述'),
    framework: z.string().default('react').describe('前端框架，如 react, vue, svelte, solid 等'),
    styleSystem: z
      .string()
      .default('tailwind')
      .describe('样式方案，如 tailwind, css-modules, styled-components, unocss, plain-css 等'),
  }),
  execute: async ({ requirement, framework, styleSystem }) => {
    // 注意：这个工具本身不调用 LLM — 它只是收集和格式化输入
    // LLM 调用由 Agent 的主循环负责
    return {
      input: { requirement, framework, styleSystem },
      instruction: `请将以下需求拆解为组件树：

需求：${requirement}
框架：${framework}
样式方案：${styleSystem}

输出格式：JSON 数组，每个元素包含 name, description, props, children 字段。
从最外层容器组件开始，递归到最小的叶子组件。`,
    };
  },
});

/**
 * planResponsiveStrategy — 响应式策略规划工具。
 *
 * 根据组件的描述和预定义的断点，为 LLM 提供结构化的响应式设计指令。
 * 输出包括：每个断点下的布局方式、元素隐藏规则、字体/间距缩放策略。
 *
 * 默认断点配置：
 *   - mobile: 375px, tablet: 768px, desktop: 1024px, wide: 1440px
 *
 * @param componentName - 组件名称
 * @param componentDescription - 组件功能描述
 * @param breakpoints - 自定义断点配置（可选，有默认值）
 * @returns 格式化的响应式设计指令
 */
export const planResponsiveStrategy = tool({
  description: '根据组件结构推荐响应式布局策略（断点、布局切换、隐藏/显示规则）',
  inputSchema: z.object({
    componentName: z.string(),
    componentDescription: z.string(),
    breakpoints: z
      .object({
        mobile: z.number().default(375),
        tablet: z.number().default(768),
        desktop: z.number().default(1024),
        wide: z.number().default(1440),
      })
      .optional(),
  }),
  execute: async ({ componentName, componentDescription, breakpoints }) => {
    // 使用提供的断点配置或回退到默认值
    const bp = breakpoints ?? { mobile: 375, tablet: 768, desktop: 1024, wide: 1440 };
    return {
      componentName,
      breakpoints: bp,
      instruction: `为 ${componentName} 组件设计响应式策略：

组件描述：${componentDescription}
断点：mobile(${bp.mobile}px) / tablet(${bp.tablet}px) / desktop(${bp.desktop}px) / wide(${bp.wide}px)

请输出：
1. 每个断点下的布局方式（flex/grid/stack）
2. 哪些元素在小屏幕需要隐藏或折叠
3. 字体/间距的缩放策略`,
    };
  },
});

/**
 * planStateManagement — 状态管理方案规划工具。
 *
 * 分析组件树结构，为 LLM 提供状态管理设计指令。
 * 帮助 LLM 决定每个组件的状态应该是：
 *   - 本地状态（useState / ref）
 *   - 跨组件共享（Context / Props drilling）
 *   - 全局状态（Zustand / Pinia / Redux）
 *
 * @param componentTree - 组件树的 JSON 字符串表示
 * @param hasGlobalState - 项目是否已使用全局状态管理（默认 false）
 * @returns 格式化的状态管理分析指令
 */
export const planStateManagement = tool({
  description: '分析组件树需要的状态管理方案（本地 state / context / 全局 store）',
  inputSchema: z.object({
    componentTree: z.string().describe('组件树 JSON 字符串'),
    hasGlobalState: z.boolean().default(false).describe('项目是否使用全局状态管理'),
  }),
  execute: async ({ componentTree, hasGlobalState }) => {
    return {
      input: { componentTree, hasGlobalState },
      instruction: `分析以下组件树的状态管理需求：

${componentTree}

为每个组件标注：
1. 哪些状态是本地的（useState）
2. 哪些状态需要跨组件共享（Context/Props drilling）
3. ${hasGlobalState ? '哪些状态应提升到全局 store' : '是否需要引入全局状态管理'}`,
    };
  },
});
