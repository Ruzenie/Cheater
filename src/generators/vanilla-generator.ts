/**
 * @file generators/vanilla-generator.ts — 原生 HTML/CSS/JS 代码生成器
 *
 * 本文件实现了 Cheater 的 Vanilla（原生前端）代码生成器，
 * 将组件规格转换为纯 HTML + CSS + JavaScript 三文件结构。
 *
 * 架构角色：
 *   - 实现 CodeGenerator 接口，可通过 getCodeGenerator('html+css+js') 获取
 *   - 适用于不使用任何前端框架的场景
 *   - 生成的是**组件片段**（fragment），而非完整 HTML 页面
 *
 * 生成产物结构：
 *   - {ComponentName}.html — 可嵌入的 HTML 片段（以 <article> 为根元素）
 *   - {ComponentName}.css  — 组件作用域内的样式（以组件类名为前缀）
 *   - {ComponentName}.js   — 原生交互逻辑（DOM 查询限定在组件根元素内）
 *
 * 关键约束（体现在 prompt 中）：
 *   - HTML 严禁输出 <!DOCTYPE>、<html>、<head>、<body> 等文档级标签
 *   - CSS 严禁写全局重置（* { margin: 0 }）或元素选择器（body {}）
 *   - JS 必须使用 root.querySelector() 而非 document.querySelector()
 *
 * @module generators/vanilla-generator
 */

import type { ComponentSpec } from '../tools/design/index.js'; // 组件规格描述
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js'; // 生成器类型

// ══════════════════════════════════════════════════════
//  骨架生成
// ══════════════════════════════════════════════════════

/**
 * 构建原生前端组件的骨架文件
 *
 * 生成三个带 TODO 占位符的文件：.html、.css、.js。
 * 组件名会从 PascalCase 转换为 kebab-case 用作 CSS 类名和 data 属性值。
 *
 * @param spec - 组件规格描述
 * @returns 骨架文件数组（html + css + js）
 */
function buildVanillaScaffold(spec: ComponentSpec): GeneratedArtifact[] {
  // 将 PascalCase 组件名转为 kebab-case（如 LoginForm → login-form）
  const baseClass = spec.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  return [
    // HTML 片段 — 使用 data-component 属性标记组件根元素，便于 JS 定位
    {
      fileName: `${spec.name}.html`,
      role: 'markup',
      content: `<article class="${baseClass}" data-component="${spec.name}">
  <!-- TODO: 实现 ${spec.name} 的 HTML 结构 -->
</article>`,
    },
    // CSS 样式 — 以组件根类名为作用域前缀
    {
      fileName: `${spec.name}.css`,
      role: 'style',
      content: `.${baseClass} {
  /* TODO: 实现 ${spec.name} 的样式 */
}`,
    },
    // JS 脚本 — 使用 data-component 属性定位组件根元素
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

// ══════════════════════════════════════════════════════
//  生成器实例（实现 CodeGenerator 接口）
// ══════════════════════════════════════════════════════

/**
 * 原生 HTML/CSS/JS 代码生成器实例
 *
 * 支持的框架别名：html+css+js, html/css/js, html, vanilla, native, javascript
 */
export const vanillaGenerator: CodeGenerator = {
  id: 'html+css+js',
  displayName: 'Vanilla HTML/CSS/JS Generator',
  frameworkAliases: ['html+css+js', 'html/css/js', 'html', 'vanilla', 'native', 'javascript'],

  /** 生成三文件骨架：.html + .css + .js */
  createScaffold(spec: ComponentSpec): GeneratedArtifact[] {
    return buildVanillaScaffold(spec);
  },
  /** 构造填充阶段的系统 prompt — 强调原生开发约束和组件片段规则 */
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
- 仅输出要求的 JSON 文件结构，不要解释

⚠ 关键约束——组件是片段，不是完整页面：
- HTML 文件必须输出可嵌入的片段（fragment），以 <article>/<section>/<div> 等容器标签作为根元素
- 严禁在 HTML 中输出 <!DOCTYPE>、<html>、<head>、<body>、<meta>、<title>、<link rel="stylesheet"> 等文档级标签——这些由组装器自动生成
- 严禁在 HTML 中引入外部 CDN 资源（如 Font Awesome、Google Fonts 等 <link> 或 <script> 标签）
- CSS 文件只写当前组件作用域内的样式，以组件根类名（如 .login-form）作为前缀
- CSS 中严禁写 * { margin:0; padding:0 } 等全局重置——全局重置由组装器统一添加
- CSS 中严禁写 body { ... }、html { ... } 等元素选择器——只用组件类名选择器
- CSS 中的 :root 变量必须以组件名为前缀（如 --login-form-bg 而非 --bg-primary），避免与其他组件冲突
- JS 文件中的 DOM 查询必须限定在组件根元素内（使用 root.querySelector 而非 document.querySelector），避免与其他组件的 ID/类名冲突
- JS 中 getElementById 等全局查询如果必须使用，ID 必须以组件名为前缀（如 loginForm-username 而非 username）`;
  },
  /** 构造填充阶段的用户 prompt — 包含骨架代码和组件需求 */
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

⚠ 你正在生成一个【组件片段】，不是完整页面：
- HTML 必须以骨架中给定的根标签（如 <article class="..." data-component="...">）为起止，不能包含 <!DOCTYPE>、<html>、<head>、<body> 等文档标签
- CSS 所有选择器必须以组件根类名为前缀（如 .${spec.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}），不能写 *、body、html 等全局选择器
- JS 中 DOM 查询使用 root.querySelector() 而非 document.querySelector()，root 是骨架中已定义的组件根元素

请补全所有原生文件实现。`;
  },
  /** 仅在纯 CSS 样式方案下支持独立的样式优化 pass */
  supportsStylePass(options: CodeGeneratorOptions): boolean {
    return options.styleMethod === 'css';
  },
  /** 构造样式优化的系统 prompt */
  buildStyleSystem(options: CodeGeneratorOptions): string {
    return `你是资深 CSS 设计师。
请仅优化现有原生文件中的 CSS 质量与视觉表现。${options.darkMode ? '\n需要包含暗色模式样式。' : ''}
保持 HTML 与 JS 文件可正常协作，保持文件名不变，仅输出要求的 JSON 文件结构。`;
  },
  /** 构造样式优化的用户 prompt */
  buildStylePrompt(_spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `请优化以下原生组件文件，重点提升 CSS 表现：

${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
  /** 构造问题修复 prompt — 列出问题清单和当前文件内容 */
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
  /** 入口文件定位 — 优先选择 .html 文件作为组件入口 */
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts.find((artifact) => artifact.fileName.endsWith('.html')) ?? artifacts[0];
  },
};
