import type { ComponentSpec } from '../tools/design/index.js';
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js';

function buildVanillaScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  const baseClass = spec.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  return [
    {
      fileName: `${spec.name}.html`,
      role: 'markup',
      content: `<article class="${baseClass}" data-component="${spec.name}">
  <!-- TODO: 实现 ${spec.name} 的 HTML 结构 -->
</article>`,
    },
    {
      fileName: `${spec.name}.css`,
      role: 'style',
      content: `.${baseClass} {
  /* TODO: 实现 ${spec.name} 的样式 */
}`,
    },
    {
      fileName: `${spec.name}.js`,
      role: 'script',
      content: `const root = document.querySelector('[data-component="${spec.name}"]');

if (root) {
  // TODO: 实现 ${spec.name} 的原生交互逻辑
}`,
    },
  ];
}

export const vanillaGenerator: CodeGenerator = {
  id: 'html+css+js',
  displayName: 'Vanilla HTML/CSS/JS Generator',
  frameworkAliases: ['html+css+js', 'html/css/js', 'html', 'vanilla', 'native', 'javascript'],
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildVanillaScaffold(spec);
  },
  buildFillSystem(options: CodeGeneratorOptions): string {
    return `你是一个高级原生前端开发工程师。
必须只使用原生 HTML、CSS、JavaScript 实现需求。
禁止使用 React、Vue、Svelte、JSX、TSX、TypeScript 类型标注。
样式方案：${options.styleMethod}${options.darkMode ? ' + dark mode' : ''}。

规则：
- 保持文件名不变
- HTML/CSS/JS 分文件输出
- 交互逻辑写在 .js 文件中
- 必须考虑响应式、暗色模式、空状态与交互反馈
- 必须输出完整的、可运行的代码——禁止输出 TODO、FIXME 或任何占位注释
- 每个文件必须包含完整实现，不能是空的骨架
- 仅输出要求的 JSON 文件结构，不要解释`;
  },
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}

当前文件骨架：
${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}

${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}: ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}
重要要求：
- 你必须用真实的、完整的、可运行的代码替换所有骨架中的 TODO 注释
- 禁止在输出中保留任何 TODO、FIXME 或占位注释
- HTML 必须包含完整的语义化结构（表单、输入框、按钮等）
- CSS 必须包含完整的样式规则（布局、颜色、间距、响应式等）
- JS 必须包含完整的交互逻辑（事件监听、状态管理、DOM 操作等）
- 每个文件的 content 字段必须是完整的代码，不能是空的或只有注释

请补全所有原生文件实现。`;
  },
  supportsStylePass(options: CodeGeneratorOptions): boolean {
    return options.styleMethod === 'css';
  },
  buildStyleSystem(options: CodeGeneratorOptions): string {
    return `你是资深 CSS 设计师。
请仅优化现有原生文件中的 CSS 质量与视觉表现。${options.darkMode ? '\n需要包含暗色模式样式。' : ''}
保持 HTML 与 JS 文件可正常协作，保持文件名不变，仅输出要求的 JSON 文件结构。`;
  },
  buildStylePrompt(_spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `请优化以下原生组件文件，重点提升 CSS 表现：

${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  buildFixPrompt(
    _spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
  ): string {
    return `修复以下原生 HTML/CSS/JS 文件中的问题，并保持文件名不变：

问题列表：
${issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')}

当前文件：
${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts.find((artifact) => artifact.fileName.endsWith('.html')) ?? artifacts[0];
  },
};
