import type { ComponentSpec } from '../tools/design/index.js';
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js';

function buildVueScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  const propsEntries = spec.props.map((prop) => {
    const defaultPart = prop.defaultValue ? `, default: ${prop.defaultValue}` : '';
    const vueType = ({ string: 'String', number: 'Number', boolean: 'Boolean', object: 'Object', array: 'Array', function: 'Function' } as Record<string, string>)[prop.type?.toLowerCase() ?? ''] ?? prop.type ?? 'String';
    return `  ${prop.name}: { type: ${vueType}${defaultPart} }`;
  });

  const stateLines = spec.states.map((state) => `const ${state.name} = ref(${state.type === 'boolean' ? 'false' : state.type === 'number' ? '0' : "''"});`);
  const eventLines = spec.events.map((event) => `function ${event.name}Handler(payload${event.payload && event.payload !== 'void' ? `: ${event.payload}` : ''}) {\n  // TODO: ${event.description || event.name}\n}`);

  const template = `<template>\n  <section class="${spec.name.toLowerCase()}">\n    <!-- TODO: 实现 ${spec.name} 的模板结构 -->\n  </section>\n</template>`;

  const script = `<script setup lang="ts">\nimport { ref } from 'vue';\n\nconst props = defineProps({\n${propsEntries.length > 0 ? propsEntries.join(',\n') : '  // TODO: 定义 props'}\n});\n\n${stateLines.length > 0 ? stateLines.join('\n') : '// TODO: 定义组件状态'}\n\n${eventLines.length > 0 ? eventLines.join('\n\n') : '// TODO: 定义交互逻辑'}\n</script>`;

  const style = `<style scoped>\n.${spec.name.toLowerCase()} {\n  /* TODO: 实现 ${spec.name} 的样式 */\n}\n</style>`;

  return [{
    fileName: `${spec.name}.vue`,
    role: 'component',
    content: `${template}\n\n${script}\n\n${style}`,
  }];
}

export const vueGenerator: CodeGenerator = {
  id: 'vue',
  displayName: 'Vue SFC Generator',
  frameworkAliases: ['vue', 'vue3', 'vue 3', 'vue+sfc'],
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildVueScaffold(spec);
  },
  buildFillSystem(options: CodeGeneratorOptions): string {
    return `你是一个高级 Vue 3 + TypeScript 开发工程师。\n必须输出 Vue 单文件组件（SFC）。\n禁止使用 React、JSX、TSX、Svelte 语法。\n样式方案：${options.styleMethod}${options.darkMode ? ' + dark mode' : ''}。\n\n规则：\n- 保持文件名不变\n- 使用 <template> / <script setup lang="ts"> / <style scoped> 结构\n- 保留组件职责，补全响应式状态、事件与展示\n- 仅输出要求的 JSON 文件结构，不要解释`;
  },
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}\n\n当前文件骨架：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}\n\n${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全完整的 Vue 单文件组件。`;
  },
  supportsStylePass(): boolean {
    return false;
  },
  buildStyleSystem(): string {
    return 'N/A';
  },
  buildStylePrompt(): string {
    return 'N/A';
  },
  buildFixPrompt(
    _spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
  ): string {
    return `修复以下 Vue 单文件组件中的问题，并保持文件名不变：\n\n问题列表：\n${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}\n\n当前文件：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
