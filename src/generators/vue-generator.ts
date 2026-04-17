/**
 * @file generators/vue-generator.ts — Vue 3 SFC 代码生成器
 *
 * 本文件实现了 Cheater 的 Vue 3 代码生成器，
 * 将组件规格转换为标准的 Vue 单文件组件（SFC）。
 *
 * 架构角色：
 *   - 实现 CodeGenerator 接口，可通过 getCodeGenerator('vue') 获取
 *   - 生成符合 Vue 3 Composition API 规范的 SFC 文件
 *   - 使用 <script setup lang="ts"> 语法糖，简洁且类型安全
 *
 * 生成产物结构：
 *   - {ComponentName}.vue — 包含 <template> / <script setup> / <style scoped> 三段式 SFC
 *
 * 特殊设计：
 *   - Props 类型映射：将 TypeScript 类型转换为 Vue 的运行时类型构造器
 *     （如 'string' → 'String', 'number' → 'Number'）
 *   - 样式优化 pass 不支持（Vue 的 scoped style 已内聚在 SFC 中）
 *
 * @module generators/vue-generator
 */

import type { ComponentSpec } from '../tools/design/index.js'; // 组件规格描述
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js'; // 生成器类型

// ══════════════════════════════════════════════════════
//  骨架生成
// ══════════════════════════════════════════════════════

/**
 * 构建 Vue SFC 组件的骨架文件
 *
 * 生成包含三个区块的 .vue 单文件：
 *   - <template>：带 TODO 占位的模板结构
 *   - <script setup lang="ts">：props 定义、响应式状态、事件处理函数
 *   - <style scoped>：组件作用域样式
 *
 * @param spec - 组件规格描述
 * @returns 包含单个 .vue 文件的产物数组
 */
function buildVueScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  // 将组件 Props 转换为 Vue 的 defineProps() 参数格式
  // TypeScript 类型需映射为 Vue 运行时类型构造器（String / Number / Boolean 等）
  const propsEntries = spec.props.map((prop) => {
    const defaultPart = prop.defaultValue ? `, default: ${prop.defaultValue}` : '';
    // 类型映射表：TS 类型 → Vue 运行时类型
    const vueType =
      (
        {
          string: 'String',
          number: 'Number',
          boolean: 'Boolean',
          object: 'Object',
          array: 'Array',
          function: 'Function',
        } as Record<string, string>
      )[prop.type?.toLowerCase() ?? ''] ??
      prop.type ?? // 未命中映射表时直接使用原始类型
      'String'; // 兜底默认类型
    return `  ${prop.name}: { type: ${vueType}${defaultPart} }`;
  });

  // 生成响应式状态声明（使用 ref()）
  const stateLines = spec.states.map(
    (state) =>
      `const ${state.name} = ref(${state.type === 'boolean' ? 'false' : state.type === 'number' ? '0' : "''"});`,
  );
  // 生成事件处理函数骨架
  const eventLines = spec.events.map(
    (event) =>
      `function ${event.name}Handler(payload${event.payload && event.payload !== 'void' ? `: ${event.payload}` : ''}) {\n  // TODO: ${event.description || event.name}\n}`,
  );

  // 组装 SFC 的三个区块
  // template — 组件模板结构
  const template = `<template>\n  <section class="${spec.name.toLowerCase()}">\n    <!-- TODO: 实现 ${spec.name} 的模板结构 -->\n  </section>\n</template>`;

  // script — props 定义、响应式状态和事件处理函数
  const script = `<script setup lang="ts">\nimport { ref } from 'vue';\n\nconst props = defineProps({\n${propsEntries.length > 0 ? propsEntries.join(',\n') : '  // TODO: 定义 props'}\n});\n\n${stateLines.length > 0 ? stateLines.join('\n') : '// TODO: 定义组件状态'}\n\n${eventLines.length > 0 ? eventLines.join('\n\n') : '// TODO: 定义交互逻辑'}\n</script>`;

  // style — scoped 样式确保样式隔离
  const style = `<style scoped>\n.${spec.name.toLowerCase()} {\n  /* TODO: 实现 ${spec.name} 的样式 */\n}\n</style>`;

  // 将三个区块合并为完整的 SFC 内容
  return [
    {
      fileName: `${spec.name}.vue`,
      role: 'component',
      content: `${template}\n\n${script}\n\n${style}`,
    },
  ];
}

// ══════════════════════════════════════════════════════
//  生成器实例（实现 CodeGenerator 接口）
// ══════════════════════════════════════════════════════

/**
 * Vue 3 SFC 代码生成器实例
 *
 * 支持的框架别名：vue, vue3, vue 3, vue+sfc
 */
export const vueGenerator: CodeGenerator = {
  id: 'vue',
  displayName: 'Vue SFC Generator',
  frameworkAliases: ['vue', 'vue3', 'vue 3', 'vue+sfc'],

  /** 生成 Vue SFC 骨架文件（template + script setup + style scoped） */
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildVueScaffold(spec);
  },
  /** 构造填充阶段的系统 prompt — 强调 Vue 3 SFC 规范和 Composition API */
  buildFillSystem(options: CodeGeneratorOptions): string {
    return `你是一个高级 Vue 3 + TypeScript 开发工程师。\n必须输出 Vue 单文件组件（SFC）。\n禁止使用 React、JSX、TSX、Svelte 语法。\n样式方案：${options.styleMethod}${options.darkMode ? ' + dark mode' : ''}。\n\n规则：\n- 保持文件名不变\n- 使用 <template> / <script setup lang="ts"> / <style scoped> 结构\n- 保留组件职责，补全响应式状态、事件与展示\n- 仅输出要求的 JSON 文件结构，不要解释`;
  },
  /** 构造填充阶段的用户 prompt — 包含 SFC 骨架和组件需求 */
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}\n\n当前文件骨架：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}\n\n${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全完整的 Vue 单文件组件。`;
  },
  /** Vue SFC 不支持独立的样式优化 pass（scoped style 已内聚在组件中） */
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
  /** 构造 Vue SFC 问题修复 prompt */
  buildFixPrompt(
    _spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
  ): string {
    return `修复以下 Vue 单文件组件中的问题，并保持文件名不变：\n\n问题列表：\n${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}\n\n当前文件：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  /** 入口文件定位 — Vue SFC 只有一个 .vue 文件 */
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
