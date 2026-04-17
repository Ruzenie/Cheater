/**
 * @file tools/assembly/index.ts — 代码组装工具集
 *
 * 本文件定义了 Code Assembler Agent 使用的全部 Vercel AI SDK 工具，
 * 负责将分散生成的组件代码整合为一个可运行的前端项目。
 *
 * 在 Cheater 系统的整体流程中，本模块处于 Pipeline 的最末端：
 *   需求精炼 → 设计分析 → 项目规划 → 代码生成 → **代码组装**
 *
 * 提供的工具：
 *   1. placeComponent       — 将组件代码放置到项目目录结构中
 *   2. generateEntryFiles   — 生成框架入口文件（main.tsx / App.vue / index.html 等）
 *   3. generateBarrelExports — 生成 barrel re-export（index.ts 统一导出）
 *   4. fixImportPaths       — 修正组件间的导入路径（适配实际目录布局）
 *   5. mergeStyles          — 合并样式文件（单文件或按组件分离）
 *   6. writeProjectToDisk   — 将完整项目写入磁盘（含自动创建目录）
 *
 * 每个工具使用 Zod 定义输入 Schema，通过 Vercel AI SDK 的 `tool()` 注册，
 * 供 AI Agent 在对话中调用。
 *
 * 此外本文件包含多个硬编码的模板生成器函数（React / Vue / Vanilla），
 * 用于生成标准化的入口文件内容。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ── 入口文件模板生成器 ──────────────────────────────
// 以下函数为各框架生成硬编码的标准入口文件内容。
// 采用模板字符串直接拼接，保持生成结果的可预测性。

/**
 * 生成 React 项目的 main.tsx 入口文件内容。
 * 包含 React 18+ 的 createRoot API 和 StrictMode 包裹。
 * @returns React main.tsx 文件的完整文本内容
 */
function generateReactMain(): string {
  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;
}

/**
 * 生成 React 项目的 App.tsx 根组件文件。
 * 自动将组件分为布局类（NavBar/Footer）和内容类，分别渲染到不同区域。
 * @param components - 需要在 App 中导入并渲染的组件列表
 * @returns App.tsx 文件的完整文本内容
 */
function generateReactApp(
  components: Array<{ name: string; importPath: string; isLayout: boolean }>,
): string {
  // 生成所有组件的 import 语句
  const imports = components.map((c) => `import ${c.name} from '${c.importPath}';`).join('\n');

  // 将组件分为两类：布局组件（如 NavBar/Footer）和内容组件
  const layoutComponents = components.filter((c) => c.isLayout);
  const contentComponents = components.filter((c) => !c.isLayout);

  const renderLayout = layoutComponents.map((c) => `      <${c.name} />`).join('\n');
  const renderContent = contentComponents.map((c) => `        <${c.name} />`).join('\n');

  return `${imports}

export default function App() {
  return (
    <div className="app">
${renderLayout}
      <main className="app__content">
${renderContent}
      </main>
    </div>
  );
}
`;
}

/**
 * 生成 React 项目的 index.html 文件。
 * 包含标准 HTML5 结构和 Vite 模块加载入口。
 * @param title - 页面标题
 * @returns index.html 文件的完整文本内容
 */
function generateReactIndexHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

/**
 * 生成 Vue 项目的 main.ts 入口文件。
 * 使用 Vue 3 的 createApp API。
 * @returns Vue main.ts 文件的完整文本内容
 */
function generateVueMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';
import './styles/globals.css';

createApp(App).mount('#app');
`;
}

/**
 * 生成 Vue 项目的 App.vue 根组件（SFC 格式）。
 * 包含 script setup、template 和 scoped style 三段式结构。
 * @param components - 需要在 App 中导入并渲染的组件列表
 * @returns App.vue 文件的完整文本内容
 */
function generateVueApp(
  components: Array<{ name: string; importPath: string; isLayout: boolean }>,
): string {
  const imports = components.map((c) => `import ${c.name} from '${c.importPath}';`).join('\n');

  const layoutTags = components
    .filter((c) => c.isLayout)
    .map((c) => `    <${c.name} />`)
    .join('\n');
  const contentTags = components
    .filter((c) => !c.isLayout)
    .map((c) => `      <${c.name} />`)
    .join('\n');

  return `<script setup lang="ts">
${imports}
</script>

<template>
  <div class="app">
${layoutTags}
    <main class="app__content">
${contentTags}
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
}
.app__content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}
</style>
`;
}

/**
 * 生成 Vue 项目的 index.html 文件。
 * @param title - 页面标题
 * @returns index.html 文件的完整文本内容
 */
function generateVueIndexHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

/**
 * 生成原生 HTML+CSS+JS 项目的 index.html 文件。
 * 每个组件生成一个 section 占位元素（data-component 标记组件名）。
 * @param title - 页面标题
 * @param components - 需要在页面中占位的组件列表
 * @returns index.html 文件的完整文本内容
 */
function generateVanillaHtml(
  title: string,
  components: Array<{ name: string; importPath: string; isLayout: boolean }>,
): string {
  const sections = components
    .map(
      (c) => `    <section data-component="${c.name}">\n      <!-- ${c.name} -->\n    </section>`,
    )
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="stylesheet" href="./styles/main.css" />
  </head>
  <body>
    <main class="app">
${sections}
    </main>
    <script src="./scripts/main.js"></script>
  </body>
</html>
`;
}

/**
 * 生成全局 CSS 重置样式文件。
 * 包含 box-sizing 重置、字体设置、图片自适应等通用样式，
 * 可选追加 prefers-color-scheme 暗色模式媒体查询。
 * @param darkMode - 是否包含暗色模式样式
 * @returns globals.css 文件的完整文本内容
 */
function generateGlobalsCss(darkMode: boolean): string {
  return `/* ── Global Styles ── */

*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}

body {
  min-height: 100vh;
  color: #1a1a1a;
  background-color: #ffffff;
}

${
  darkMode
    ? `@media (prefers-color-scheme: dark) {
  body {
    color: #f0f0f0;
    background-color: #1a1a1a;
  }
}
`
    : ''
}
img,
picture,
video,
canvas,
svg {
  display: block;
  max-width: 100%;
}

input,
button,
textarea,
select {
  font: inherit;
}
`;
}

// ── AI SDK 工具定义 ──────────────────────────────────
// 以下是通过 Vercel AI SDK 的 tool() 注册的 Agent 可调用工具。
// 每个工具都有 Zod 定义的 inputSchema 和异步 execute 函数。

/**
 * placeComponent — 将组件代码放置到项目结构中的指定路径。
 *
 * 接收 Code Producer 输出的文件列表，将它们映射到项目目录结构中。
 * 可选地为组件目录生成 index.ts re-export 文件（html+css+js 除外）。
 *
 * @param componentName - 组件名称（PascalCase）
 * @param artifacts - Code Producer 生成的文件列表（fileName + content + role）
 * @param targetDir - 目标目录路径（相对于项目根目录）
 * @param createIndex - 是否生成 index.ts 导出文件（默认 true）
 * @param framework - 目标框架（默认 react）
 * @returns 文件路径和内容的映射，以及放置结果摘要
 */
export const placeComponent = tool({
  description: '将生成的组件代码放置到项目结构中的指定路径，返回目标文件路径和内容的映射',
  inputSchema: z.object({
    componentName: z.string().describe('组件名（PascalCase）'),
    artifacts: z
      .array(
        z.object({
          fileName: z.string(),
          content: z.string(),
          role: z.string().describe('文件角色：component, style, script, markup'),
        }),
      )
      .describe('Code Producer 生成的文件列表'),
    targetDir: z.string().describe('目标目录路径（相对项目根），如 src/components/LoginForm'),
    createIndex: z.boolean().default(true).describe('是否为组件目录生成 index.ts re-export'),
    framework: z.string().default('react').describe('目标框架'),
  }),
  execute: async ({ componentName, artifacts, targetDir, createIndex, framework }) => {
    const files: Array<{ filePath: string; content: string }> = [];

    // 将每个构件文件映射到目标目录下
    for (const artifact of artifacts) {
      files.push({
        filePath: `${targetDir}/${artifact.fileName}`,
        content: artifact.content,
      });
    }

    // 为非原生 HTML 框架生成 index.ts 文件，实现默认导出的 re-export
    if (createIndex && framework !== 'html+css+js') {
      // 优先找 role=component 的文件作为主文件，找不到则取第一个
      const mainFile = artifacts.find((a) => a.role === 'component') ?? artifacts[0];
      const ext = mainFile.fileName.split('.').pop();
      // 去掉文件扩展名作为导入路径
      const importName = mainFile.fileName.replace(`.${ext}`, '');
      files.push({
        filePath: `${targetDir}/index.ts`,
        content: `export { default } from './${importName}';\n`,
      });
    }

    return {
      componentName,
      targetDir,
      files,
      totalFiles: files.length,
      instruction: `组件 ${componentName} 已放置到 ${targetDir}/，共 ${files.length} 个文件`,
    };
  },
});

/**
 * generateEntryFiles — 生成框架标准入口文件。
 *
 * 根据目标框架生成一整套入口文件（main.tsx / App.tsx / index.html / globals.css 等）。
 * 内部调用上方的模板生成器函数。
 *
 * @param framework - 目标框架（react / vue / html+css+js）
 * @param components - 需要在入口文件中导入的组件列表
 * @param styleMethod - 样式方案（默认 tailwind）
 * @param pageTitle - 页面标题（默认 'My App'）
 * @param darkMode - 是否支持暗色模式（默认 false）
 * @returns 生成的文件列表及摘要信息
 */
export const generateEntryFiles = tool({
  description: '生成框架标准入口文件（main.tsx, App.tsx, index.html 等），返回文件路径和内容',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    components: z
      .array(
        z.object({
          name: z.string().describe('组件名'),
          importPath: z.string().describe('导入路径（相对于 src/），如 ./components/NavBar'),
          isLayout: z.boolean().default(false).describe('是否是布局组件（如 NavBar, Footer）'),
        }),
      )
      .describe('需要在入口文件中导入的组件列表'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    pageTitle: z.string().default('My App').describe('页面标题'),
    darkMode: z.boolean().default(false).describe('是否支持暗色模式'),
  }),
  execute: async ({ framework, components, pageTitle, darkMode }) => {
    // 标准化框架名称：包含 'html' 的统一映射为 'html+css+js'
    const fwKey = framework.toLowerCase().includes('html')
      ? 'html+css+js'
      : framework.toLowerCase();
    const files: Array<{ filePath: string; content: string; role: string }> = [];

    // 根据框架类型生成不同的入口文件组合
    if (fwKey === 'react') {
      files.push(
        { filePath: 'src/main.tsx', content: generateReactMain(), role: 'entry' },
        { filePath: 'src/App.tsx', content: generateReactApp(components), role: 'entry' },
        { filePath: 'index.html', content: generateReactIndexHtml(pageTitle), role: 'entry' },
        {
          filePath: 'src/styles/globals.css',
          content: generateGlobalsCss(darkMode),
          role: 'style',
        },
      );
    } else if (fwKey === 'vue') {
      files.push(
        { filePath: 'src/main.ts', content: generateVueMain(), role: 'entry' },
        { filePath: 'src/App.vue', content: generateVueApp(components), role: 'entry' },
        { filePath: 'index.html', content: generateVueIndexHtml(pageTitle), role: 'entry' },
        {
          filePath: 'src/styles/globals.css',
          content: generateGlobalsCss(darkMode),
          role: 'style',
        },
      );
    } else {
      // html+css+js / svelte — 简化处理：只需 index.html + CSS + JS 三个文件
      files.push(
        {
          filePath: 'index.html',
          content: generateVanillaHtml(pageTitle, components),
          role: 'entry',
        },
        { filePath: 'styles/main.css', content: generateGlobalsCss(darkMode), role: 'style' },
        { filePath: 'scripts/main.js', content: '// Application entry\n', role: 'script' },
      );
    }

    return {
      framework: fwKey,
      files,
      totalFiles: files.length,
      instruction: `已生成 ${fwKey} 入口文件 ${files.length} 个`,
    };
  },
});

/**
 * generateBarrelExports — 为组件目录生成 barrel re-export 文件。
 *
 * 生成 index.ts 文件，统一导出所有组件，方便使用方通过单一路径导入。
 * 例如：export { default as NavBar } from './NavBar';
 *
 * @param components - 需要包含在 barrel 文件中的组件列表
 * @param outputPath - barrel 文件的输出路径（默认 'src/components/index.ts'）
 * @returns 文件路径、内容和总导出数量
 */
export const generateBarrelExports = tool({
  description: '为组件目录生成 index.ts barrel re-export 文件，方便统一导入',
  inputSchema: z.object({
    components: z
      .array(
        z.object({
          name: z.string().describe('组件名'),
          dirName: z.string().describe('组件目录名（通常与组件名相同）'),
          isDefault: z.boolean().default(true).describe('是否是默认导出'),
        }),
      )
      .describe('需要包含在 barrel 文件中的组件'),
    outputPath: z.string().default('src/components/index.ts').describe('barrel 文件输出路径'),
  }),
  execute: async ({ components, outputPath }) => {
    // 根据是否默认导出，生成对应的 export 语法
    const lines = components.map((c) =>
      c.isDefault
        ? `export { default as ${c.name} } from './${c.dirName}';`
        : `export { ${c.name} } from './${c.dirName}';`,
    );

    return {
      filePath: outputPath,
      content: lines.join('\n') + '\n',
      totalExports: components.length,
    };
  },
});

/**
 * fixImportPaths — 修正组件代码中的导入路径。
 *
 * 组件在生成时的 import 路径可能不匹配实际项目目录结构。
 * 本工具根据 importMapping（原始路径→目标路径）计算相对路径并替换。
 * 自动去掉 TypeScript/JSX/Vue/Svelte 文件扩展名。
 *
 * @param code - 需要修正导入路径的源代码
 * @param currentFilePath - 该文件在项目中的路径（相对项目根）
 * @param importMapping - 导入路径映射表 { 原始路径: 目标路径 }
 * @returns 修正后的代码、修正数量和结果说明
 */
export const fixImportPaths = tool({
  description: '修正组件代码中的导入路径，使其匹配项目结构中的实际文件位置',
  inputSchema: z.object({
    code: z.string().describe('需要修正导入路径的源代码'),
    currentFilePath: z.string().describe('该文件在项目中的路径（相对项目根）'),
    importMapping: z.record(z.string()).describe('导入路径映射：{ 原始路径: 目标路径 }'),
  }),
  execute: async ({ code, currentFilePath, importMapping }) => {
    let result = code;
    let fixCount = 0;

    for (const [original, target] of Object.entries(importMapping)) {
      // 基于文件所在目录计算到目标文件的相对路径
      const currentDir = path.dirname(currentFilePath);
      let relativePath = path.relative(currentDir, target);
      // 确保相对路径以 './' 开头（Node.js 的 path.relative 可能省略）
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }
      // 去掉扩展名（TypeScript import 不需要 .ts/.tsx 后缀）
      relativePath = relativePath.replace(/\.(tsx?|jsx?|vue|svelte)$/, '');

      // 构建正则：匹配 from 'xxx' 或 from "xxx" 中的路径部分
      // 对原始路径中的特殊正则字符进行转义
      const regex = new RegExp(
        `(from\\s+['"])${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`,
        'g',
      );

      // 仅在匹配成功时替换并计数
      if (regex.test(result)) {
        result = result.replace(regex, `$1${relativePath}$2`);
        fixCount++;
      }
    }

    return {
      code: result,
      fixCount,
      instruction: fixCount > 0 ? `修正了 ${fixCount} 个导入路径` : '无需修正导入路径',
    };
  },
});

/**
 * mergeStyles — 将多个组件的样式合并。
 *
 * 支持两种策略：
 *   - 'single-file'：所有组件样式合并为一个 CSS 文件（用注释分隔各组件区域）
 *   - 'per-component'：保持每个组件独立的样式文件
 *
 * @param styles - 各组件的样式文件（componentName + content + fileName）
 * @param outputStrategy - 合并策略（默认 'per-component'）
 * @param outputPath - single-file 模式下的输出路径
 * @returns 合并后的文件列表和策略信息
 */
export const mergeStyles = tool({
  description: '将多个组件的样式合并，支持单文件合并或保持按组件分离',
  inputSchema: z.object({
    styles: z
      .array(
        z.object({
          componentName: z.string(),
          content: z.string(),
          fileName: z.string(),
        }),
      )
      .describe('各组件的样式文件'),
    outputStrategy: z
      .enum(['single-file', 'per-component'])
      .default('per-component')
      .describe('合并策略'),
    outputPath: z.string().optional().describe('single-file 模式下的输出路径'),
  }),
  execute: async ({ styles, outputStrategy, outputPath }) => {
    if (outputStrategy === 'single-file') {
      // 单文件模式：用注释标记分隔各组件的样式区块
      const merged = styles.map((s) => `/* ── ${s.componentName} ── */\n${s.content}`).join('\n\n');
      return {
        files: [{ filePath: outputPath ?? 'styles/components.css', content: merged }],
        strategy: 'single-file',
        totalComponents: styles.length,
      };
    }

    // per-component 模式：保持各组件样式文件独立
    return {
      files: styles.map((s) => ({ filePath: s.fileName, content: s.content })),
      strategy: 'per-component',
      totalComponents: styles.length,
    };
  },
});

/**
 * writeProjectToDisk — 将组装好的完整项目文件写入磁盘。
 *
 * 这是整个 Pipeline 的最终输出步骤。
 * 自动递归创建所需的目录结构，将所有文件写入到指定的输出目录。
 * 可选地在写入前清空目标目录（避免旧文件残留）。
 *
 * @param outputDir - 输出目录的绝对路径
 * @param files - 所有需要写入的文件（filePath 为相对项目根的路径）
 * @param clean - 写入前是否清空目标目录（默认 true）
 * @param directories - 需要预先创建的空目录列表（可选）
 * @returns 写入的文件列表和结果摘要
 */
export const writeProjectToDisk = tool({
  description: '将组装好的完整项目文件写入磁盘目录，自动创建所需的目录结构',
  inputSchema: z.object({
    outputDir: z.string().describe('输出目录的绝对路径'),
    files: z
      .array(
        z.object({
          filePath: z.string().describe('相对项目根的路径'),
          content: z.string().describe('文件内容'),
        }),
      )
      .describe('所有需要写入的文件'),
    clean: z.boolean().default(true).describe('写入前是否清空目标目录'),
    directories: z.array(z.string()).optional().default([]).describe('需要预先创建的空目录列表'),
  }),
  execute: async ({ outputDir, files, clean, directories }) => {
    // 第一步：按需清空目标目录（避免旧文件干扰）
    if (clean) {
      await rm(outputDir, { recursive: true, force: true });
    }

    // 第二步：预先创建指定的空目录
    for (const dir of directories ?? []) {
      await mkdir(path.join(outputDir, dir), { recursive: true });
    }

    // 第三步：逐个写入文件，自动创建父目录
    const writtenPaths: string[] = [];
    for (const file of files) {
      const absPath = path.join(outputDir, file.filePath);
      // 确保文件所在的目录存在
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, file.content, 'utf8');
      writtenPaths.push(file.filePath);
    }

    return {
      outputDir,
      writtenFiles: writtenPaths,
      totalFiles: writtenPaths.length,
      instruction: `已将 ${writtenPaths.length} 个文件写入 ${outputDir}`,
    };
  },
});
