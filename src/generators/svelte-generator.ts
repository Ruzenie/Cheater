/**
 * @file generators/svelte-generator.ts — Svelte 组件代码生成器
 *
 * 本文件实现了 Cheater 的 Svelte 代码生成器，
 * 将组件规格转换为标准的 Svelte 组件文件。
 *
 * 架构角色：
 *   - 实现 CodeGenerator 接口，可通过 getCodeGenerator('svelte') 获取
 *   - 生成符合 Svelte 规范的单文件组件（<script> / markup / <style>）
 *   - 使用 Svelte 的 export let 语法声明 props
 *
 * 生成产物结构：
 *   - {ComponentName}.svelte — 包含 script / markup / style 的完整 Svelte 组件
 *
 * 特殊设计：
 *   - Props 通过 export let 声明（Svelte 惯用方式）
 *   - 响应式状态使用 let 声明（Svelte 的编译器会自动追踪变化）
 *   - 样式优化 pass 不支持（Svelte 的 style 默认就是组件作用域的）
 *
 * @module generators/svelte-generator
 */

import type { ComponentSpec } from '../tools/design/index.js'; // 组件规格描述
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js'; // 生成器类型

// ══════════════════════════════════════════════════════
//  骨架生成
// ══════════════════════════════════════════════════════

/**
 * 构建 Svelte 组件的骨架文件
 *
 * 生成包含三个区域的 .svelte 文件：
 *   - <script>：export let props、let 状态、事件处理函数
 *   - markup：HTML 模板结构
 *   - <style>：组件作用域样式
 *
 * @param spec - 组件规格描述
 * @returns 包含单个 .svelte 文件的产物数组
 */
function buildSvelteScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  // 使用 Svelte 的 export let 语法声明 Props
  const exportLines = spec.props.map(
    (prop) => `export let ${prop.name}${prop.defaultValue ? ` = ${prop.defaultValue}` : ''};`,
  );
  // 使用 let 声明响应式状态（Svelte 编译器自动追踪）
  const stateLines = spec.states.map(
    (state) =>
      `let ${state.name} = ${state.type === 'boolean' ? 'false' : state.type === 'number' ? '0' : "''"};`,
  );
  // 生成事件处理函数骨架
  const eventLines = spec.events.map(
    (event) =>
      `function ${event.name}Handler(event) {\n  // TODO: ${event.description || event.name}\n}`,
  );

  // 组装 <script> + markup + <style> 为完整的 Svelte 组件内容
  const content = `<script>\n${exportLines.length > 0 ? exportLines.join('\n') : '// TODO: 定义 props'}\n\n${stateLines.length > 0 ? stateLines.join('\n') : '// TODO: 定义组件状态'}\n\n${eventLines.length > 0 ? eventLines.join('\n\n') : '// TODO: 定义交互逻辑'}\n</script>\n\n<section class="${spec.name.toLowerCase()}">\n  <!-- TODO: 实现 ${spec.name} 的标记结构 -->\n</section>\n\n<style>\n.${spec.name.toLowerCase()} {\n  /* TODO: 实现 ${spec.name} 的样式 */\n}\n</style>`;

  return [
    {
      fileName: `${spec.name}.svelte`,
      role: 'component',
      content,
    },
  ];
}

// ══════════════════════════════════════════════════════
//  生成器实例（实现 CodeGenerator 接口）
// ══════════════════════════════════════════════════════

/**
 * Svelte 组件代码生成器实例
 *
 * 支持的框架别名：svelte, sveltekit, svelte kit
 */
export const svelteGenerator: CodeGenerator = {
  id: 'svelte',
  displayName: 'Svelte Component Generator',
  frameworkAliases: ['svelte', 'sveltekit', 'svelte kit'],

  /** 生成 Svelte 组件骨架文件（script + markup + style） */
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildSvelteScaffold(spec);
  },
  /** 构造填充阶段的系统 prompt — 强调 Svelte 语法规范 */
  buildFillSystem(options: CodeGeneratorOptions): string {
    return `你是一个高级 Svelte 开发工程师。
必须输出标准 \`.svelte\` 组件文件。
禁止使用 React、Vue、JSX、TSX 语法。
样式方案：${options.styleMethod}${options.darkMode ? ' + dark mode' : ''}。

规则：
- 保持文件名不变
- 使用 <script> / markup / <style> 结构
- 保留组件职责，补全状态、交互与展示
- 仅输出要求的 JSON 文件结构，不要解释`;
  },
  /** 构造填充阶段的用户 prompt — 包含 Svelte 骨架和组件需求 */
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}\n\n当前文件骨架：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}\n\n${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全完整的 Svelte 组件。`;
  },
  /** Svelte 不支持独立的样式优化 pass（组件内 style 已自动作用域化） */
  supportsStylePass(): boolean {
    return false;
  },
  /** 样式系统 prompt — 不适用（返回 N/A） */
  buildStyleSystem(): string {
    return 'N/A';
  },
  /** 样式用户 prompt — 不适用（返回 N/A） */
  buildStylePrompt(): string {
    return 'N/A';
  },
  /** 构造 Svelte 组件问题修复 prompt */
  buildFixPrompt(
    _spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
  ): string {
    return `修复以下 Svelte 组件中的问题，并保持文件名不变：\n\n问题列表：\n${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}\n\n当前文件：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  /** 入口文件定位 — Svelte 组件只有一个 .svelte 文件 */
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
