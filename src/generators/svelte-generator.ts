import type { ComponentSpec } from '../tools/design/index.js';
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js';

function buildSvelteScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  const exportLines = spec.props.map(
    (prop) => `export let ${prop.name}${prop.defaultValue ? ` = ${prop.defaultValue}` : ''};`,
  );
  const stateLines = spec.states.map(
    (state) =>
      `let ${state.name} = ${state.type === 'boolean' ? 'false' : state.type === 'number' ? '0' : "''"};`,
  );
  const eventLines = spec.events.map(
    (event) =>
      `function ${event.name}Handler(event) {\n  // TODO: ${event.description || event.name}\n}`,
  );

  const content = `<script>\n${exportLines.length > 0 ? exportLines.join('\n') : '// TODO: 定义 props'}\n\n${stateLines.length > 0 ? stateLines.join('\n') : '// TODO: 定义组件状态'}\n\n${eventLines.length > 0 ? eventLines.join('\n\n') : '// TODO: 定义交互逻辑'}\n</script>\n\n<section class="${spec.name.toLowerCase()}">\n  <!-- TODO: 实现 ${spec.name} 的标记结构 -->\n</section>\n\n<style>\n.${spec.name.toLowerCase()} {\n  /* TODO: 实现 ${spec.name} 的样式 */\n}\n</style>`;

  return [
    {
      fileName: `${spec.name}.svelte`,
      role: 'component',
      content,
    },
  ];
}

export const svelteGenerator: CodeGenerator = {
  id: 'svelte',
  displayName: 'Svelte Component Generator',
  frameworkAliases: ['svelte', 'sveltekit', 'svelte kit'],
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildSvelteScaffold(spec);
  },
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
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}\n\n当前文件骨架：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}\n\n${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全完整的 Svelte 组件。`;
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
    return `修复以下 Svelte 组件中的问题，并保持文件名不变：\n\n问题列表：\n${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}\n\n当前文件：\n${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
