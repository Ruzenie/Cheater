/**
 * design tools — 设计分析相关工具集
 *
 * 供 Design Analyzer Agent 使用
 */

import { tool } from 'ai';
import { z } from 'zod';

// ── 组件规格 Schema（贯穿整个 pipeline 的核心数据结构）──

export const ComponentSpecSchema = z.object({
  name: z.string().describe('组件名称，PascalCase'),
  description: z.string().describe('组件职责描述'),
  props: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean().optional().default(false),
    defaultValue: z.string().optional(),
    description: z.string().optional().default(''),
  })).optional().default([]),
  children: z.array(z.string()).describe('子组件名称列表').optional().default([]),
  states: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string().optional().default(''),
  })).describe('内部状态').optional().default([]),
  events: z.array(z.object({
    name: z.string(),
    payload: z.string().optional().default('void'),
    description: z.string().optional().default(''),
  })).describe('对外事件').optional().default([]),
});

export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

// ── 工具定义 ──────────────────────────────────────────

/**
 * 需求拆解工具：将自然语言需求拆解为组件树
 */
export const decomposeRequirement = tool({
  description: '将前端需求拆解为组件树结构，输出每个组件的名称、职责和层级关系',
  inputSchema: z.object({
    requirement: z.string().describe('前端需求描述'),
    framework: z.string().default('react').describe('前端框架，如 react, vue, svelte, solid 等'),
    styleSystem: z.string().default('tailwind').describe('样式方案，如 tailwind, css-modules, styled-components, unocss, plain-css 等'),
  }),
  execute: async ({ requirement, framework, styleSystem }) => {
    // 这个工具本身不调用 LLM — 它只是收集和格式化输入
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
 * 响应式策略工具：为组件推荐响应式方案
 */
export const planResponsiveStrategy = tool({
  description: '根据组件结构推荐响应式布局策略（断点、布局切换、隐藏/显示规则）',
  inputSchema: z.object({
    componentName: z.string(),
    componentDescription: z.string(),
    breakpoints: z.object({
      mobile: z.number().default(375),
      tablet: z.number().default(768),
      desktop: z.number().default(1024),
      wide: z.number().default(1440),
    }).optional(),
  }),
  execute: async ({ componentName, componentDescription, breakpoints }) => {
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
 * 状态设计工具：分析组件需要哪些状态
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
