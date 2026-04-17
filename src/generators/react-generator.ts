/**
 * @file generators/react-generator.ts — React/TSX 代码生成器
 *
 * 本文件实现了 Cheater 的 React 代码生成器，
 * 将组件规格转换为标准的 React + TypeScript（TSX）组件。
 *
 * 架构角色：
 *   - 实现 CodeGenerator 接口，可通过 getCodeGenerator('react') 获取
 *   - 是系统的**默认生成器**（当无法确定框架时回退到 React）
 *   - 支持 CSS Modules、Tailwind、Styled Components 等多种样式方案
 *
 * 生成产物结构：
 *   - {ComponentName}.tsx — 包含 Props 接口和函数组件的完整 TSX 文件
 *   - （可选）{ComponentName}.module.css — CSS Modules 样式文件
 *
 * @module generators/react-generator
 */

import type { ComponentSpec } from '../tools/design/index.js'; // 组件规格描述
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js'; // 生成器类型

// ══════════════════════════════════════════════════════
//  骨架生成
// ══════════════════════════════════════════════════════

/**
 * 构建 React 组件的骨架文件
 *
 * 根据组件规格自动生成：
 *   - Props 接口定义（从 spec.props 提取）
 *   - 函数组件签名（包含 props 解构和默认值）
 *   - 样式导入（根据 styleMethod 决定导入方式）
 *   - children 支持（根据 spec.children 决定是否添加）
 *
 * @param spec        - 组件规格描述
 * @param styleMethod - 样式方案（'css-modules' / 'tailwind' 等）
 * @returns 包含单个 .tsx 文件的产物数组
 */
function buildReactScaffold(spec: ComponentSpec, styleMethod: string): GeneratedArtifact[] {
  // 从组件规格中提取 Props 接口的每一行
  const propsLines = spec.props.map((p) => {
    const optional = p.required ? '' : '?'; // 非必需 prop 添加可选标记
    return `  ${p.name}${optional}: ${p.type};`;
  });

  // 如果组件有子组件插槽，添加 children prop
  const hasChildren = (spec.children?.length ?? 0) > 0;
  if (hasChildren) {
    propsLines.push('  children?: React.ReactNode;');
  }

  const propsInterface = `export interface ${spec.name}Props {\n${propsLines.join('\n')}\n}`;
  const defaultProps = spec.props
    .filter((p) => p.defaultValue)
    .map((p) => `    ${p.name} = ${p.defaultValue},`)
    .join('\n');
  const destructure = spec.props.map((p) => p.name).join(', ');

  const imports = ["import React from 'react';"];
  if (styleMethod === 'css-modules') {
    imports.push(`import styles from './${spec.name}.module.css';`);
  }

  const classAttr =
    styleMethod === 'css-modules'
      ? ' className={styles.root}'
      : styleMethod === 'tailwind'
        ? ' className=""'
        : '';

  const content = `${imports.join('\n')}\n\n${propsInterface}\n\nexport default function ${spec.name}({\n${defaultProps ? `${defaultProps}\n` : ''}    ${destructure}${hasChildren ? ', children' : ''}\n}: ${spec.name}Props) {\n  return (\n    <div${classAttr}>\n      {/* TODO: 实现 ${spec.name} 组件内容 */}\n      ${hasChildren ? '{children}' : ''}\n    </div>\n  );\n}`;

  return [{ fileName: `${spec.name}.tsx`, content, role: 'component' }];
}

// ══════════════════════════════════════════════════════
//  生成器实例（实现 CodeGenerator 接口）
// ══════════════════════════════════════════════════════

/**
 * React/TSX 代码生成器实例
 *
 * 支持的框架别名：react, react+ts, react-ts, tsx
 * 同时作为系统的默认回退生成器。
 */
export const reactGenerator: CodeGenerator = {
  id: 'react',
  displayName: 'React TSX Generator',
  frameworkAliases: ['react', 'react+ts', 'react-ts', 'tsx'],

  /** 生成带 Props 接口和函数组件的 TSX 骨架文件 */
  createScaffold(spec: ComponentSpec, options: CodeGeneratorOptions): GeneratedArtifact[] {
    return buildReactScaffold(spec, options.styleMethod);
  },
  /** 构造填充阶段的系统 prompt — 设定 React + TypeScript 开发角色 */
  buildFillSystem(options: CodeGeneratorOptions): string {
    return `你是一个高级 React + TypeScript 开发工程师。
基于给定文件骨架补全实现。
样式方案：${options.styleMethod}${options.darkMode ? ' + dark mode' : ''}。

规则：
- 保持文件名不变
- 保留 Props 接口和函数签名
- 使用 React/TSX 输出
- 事件处理函数使用 handle 前缀
- 必须处理空数据、加载中、错误状态
- 仅输出要求的 JSON 文件结构，不要解释`;
  },
  /** 构造填充阶段的用户 prompt — 包含骨架代码、状态和事件需求 */
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}

当前文件：
${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}

${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全所有文件实现。`;
  },
  /** 仅 Tailwind 样式方案支持独立的样式优化 pass（补充类名） */
  supportsStylePass(options: CodeGeneratorOptions): boolean {
    return options.styleMethod === 'tailwind';
  },
  /** 构造 Tailwind 样式优化的系统 prompt */
  buildStyleSystem(options: CodeGeneratorOptions): string {
    return `你是 Tailwind CSS 专家。
请为现有 React 组件补充合适的 Tailwind 类名。${options.darkMode ? '\n需要包含 dark: 变体。' : ''}
保持文件名不变，仅输出要求的 JSON 文件结构。`;
  },
  /** 构造 Tailwind 样式优化的用户 prompt */
  buildStylePrompt(_spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `请为以下 React 文件补充 Tailwind 类名：

${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  /** 构造问题修复 prompt — 列出问题清单和当前 TSX 文件 */
  buildFixPrompt(
    _spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
  ): string {
    return `修复以下 React/TSX 文件中的问题，并保持文件名不变：

问题列表：
${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}

当前文件：
${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  /** 入口文件定位 — React 组件总是第一个文件（.tsx） */
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
