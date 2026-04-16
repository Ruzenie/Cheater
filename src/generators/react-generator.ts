import type { ComponentSpec } from '../tools/design/index.js';
import type { CodeGenerator, CodeGeneratorOptions, GeneratedArtifact } from './types.js';

function buildReactScaffold(spec: ComponentSpec, styleMethod: string): GeneratedArtifact[] {
  const propsLines = spec.props.map((p) => {
    const optional = p.required ? '' : '?';
    return `  ${p.name}${optional}: ${p.type};`;
  });

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

  const imports = ['import React from \'react\';'];
  if (styleMethod === 'css-modules') {
    imports.push(`import styles from './${spec.name}.module.css';`);
  }

  const classAttr =
    styleMethod === 'css-modules' ? ' className={styles.root}' :
    styleMethod === 'tailwind' ? ' className=""' : '';

  const content = `${imports.join('\n')}\n\n${propsInterface}\n\nexport default function ${spec.name}({\n${defaultProps ? `${defaultProps}\n` : ''}    ${destructure}${hasChildren ? ', children' : ''}\n}: ${spec.name}Props) {\n  return (\n    <div${classAttr}>\n      {/* TODO: 实现 ${spec.name} 组件内容 */}\n      ${hasChildren ? '{children}' : ''}\n    </div>\n  );\n}`;

  return [{ fileName: `${spec.name}.tsx`, content, role: 'component' }];
}

export const reactGenerator: CodeGenerator = {
  id: 'react',
  displayName: 'React TSX Generator',
  frameworkAliases: ['react', 'react+ts', 'react-ts', 'tsx'],
  createScaffold(spec: ComponentSpec, options: CodeGeneratorOptions): GeneratedArtifact[] {
    return buildReactScaffold(spec, options.styleMethod);
  },
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
  buildFillPrompt(spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `组件描述：${spec.description}

当前文件：
${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}

${spec.states.length > 0 ? `需要的状态：${spec.states.map((state) => `${state.name}(${state.type}): ${state.description}`).join(', ')}\n` : ''}${spec.events.length > 0 ? `需要的事件：${spec.events.map((event) => `${event.name}: ${event.description}`).join(', ')}\n` : ''}请补全所有文件实现。`;
  },
  supportsStylePass(options: CodeGeneratorOptions): boolean {
    return options.styleMethod === 'tailwind';
  },
  buildStyleSystem(options: CodeGeneratorOptions): string {
    return `你是 Tailwind CSS 专家。
请为现有 React 组件补充合适的 Tailwind 类名。${options.darkMode ? '\n需要包含 dark: 变体。' : ''}
保持文件名不变，仅输出要求的 JSON 文件结构。`;
  },
  buildStylePrompt(_spec: ComponentSpec, artifacts: GeneratedArtifact[]): string {
    return `请为以下 React 文件补充 Tailwind 类名：

${artifacts.map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`).join('\n\n')}`;
  },
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
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact {
    if (artifacts.length === 0) throw new Error('getEntryArtifact: artifacts 数组为空');
    return artifacts[0];
  },
};
