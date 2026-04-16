/**
 * tools/assembly/index.ts — 代码组装工具集
 *
 * 为 Code Assembler Agent 提供的工具：
 *   1. placeComponent       — 将组件代码放置到目标路径
 *   2. generateEntryFiles   — 生成框架标准入口文件
 *   3. generateBarrelExports — 生成 barrel re-export 文件
 *   4. fixImportPaths       — 修正组件中的导入路径
 *   5. mergeStyles          — 合并样式文件
 *   6. writeProjectToDisk   — 将完整项目写入磁盘
 */

import { tool } from 'ai';
import { z } from 'zod';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ── 入口文件模板 ──────────────────────────────────

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

function generateReactApp(components: Array<{ name: string; importPath: string; isLayout: boolean }>): string {
  const imports = components
    .map((c) => `import ${c.name} from '${c.importPath}';`)
    .join('\n');

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

function generateVueMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';
import './styles/globals.css';

createApp(App).mount('#app');
`;
}

function generateVueApp(components: Array<{ name: string; importPath: string; isLayout: boolean }>): string {
  const imports = components
    .map((c) => `import ${c.name} from '${c.importPath}';`)
    .join('\n');

  const layoutTags = components.filter((c) => c.isLayout).map((c) => `    <${c.name} />`).join('\n');
  const contentTags = components.filter((c) => !c.isLayout).map((c) => `      <${c.name} />`).join('\n');

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

function generateVanillaHtml(
  title: string,
  components: Array<{ name: string; importPath: string; isLayout: boolean }>,
): string {
  const sections = components
    .map((c) => `    <section data-component="${c.name}">\n      <!-- ${c.name} -->\n    </section>`)
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

${darkMode ? `@media (prefers-color-scheme: dark) {
  body {
    color: #f0f0f0;
    background-color: #1a1a1a;
  }
}
` : ''}
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

// ── 工具定义 ──────────────────────────────────────

export const placeComponent = tool({
  description: '将生成的组件代码放置到项目结构中的指定路径，返回目标文件路径和内容的映射',
  inputSchema: z.object({
    componentName: z.string().describe('组件名（PascalCase）'),
    artifacts: z.array(z.object({
      fileName: z.string(),
      content: z.string(),
      role: z.string().describe('文件角色：component, style, script, markup'),
    })).describe('Code Producer 生成的文件列表'),
    targetDir: z.string().describe('目标目录路径（相对项目根），如 src/components/LoginForm'),
    createIndex: z.boolean().default(true).describe('是否为组件目录生成 index.ts re-export'),
    framework: z.string().default('react').describe('目标框架'),
  }),
  execute: async ({ componentName, artifacts, targetDir, createIndex, framework }) => {
    const files: Array<{ filePath: string; content: string }> = [];

    for (const artifact of artifacts) {
      files.push({
        filePath: `${targetDir}/${artifact.fileName}`,
        content: artifact.content,
      });
    }

    if (createIndex && framework !== 'html+css+js') {
      const mainFile = artifacts.find((a) => a.role === 'component') ?? artifacts[0];
      const ext = mainFile.fileName.split('.').pop();
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

export const generateEntryFiles = tool({
  description: '生成框架标准入口文件（main.tsx, App.tsx, index.html 等），返回文件路径和内容',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    components: z.array(z.object({
      name: z.string().describe('组件名'),
      importPath: z.string().describe('导入路径（相对于 src/），如 ./components/NavBar'),
      isLayout: z.boolean().default(false).describe('是否是布局组件（如 NavBar, Footer）'),
    })).describe('需要在入口文件中导入的组件列表'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    pageTitle: z.string().default('My App').describe('页面标题'),
    darkMode: z.boolean().default(false).describe('是否支持暗色模式'),
  }),
  execute: async ({ framework, components, pageTitle, darkMode }) => {
    const fwKey = framework.toLowerCase().includes('html') ? 'html+css+js' : framework.toLowerCase();
    const files: Array<{ filePath: string; content: string; role: string }> = [];

    if (fwKey === 'react') {
      files.push(
        { filePath: 'src/main.tsx', content: generateReactMain(), role: 'entry' },
        { filePath: 'src/App.tsx', content: generateReactApp(components), role: 'entry' },
        { filePath: 'index.html', content: generateReactIndexHtml(pageTitle), role: 'entry' },
        { filePath: 'src/styles/globals.css', content: generateGlobalsCss(darkMode), role: 'style' },
      );
    } else if (fwKey === 'vue') {
      files.push(
        { filePath: 'src/main.ts', content: generateVueMain(), role: 'entry' },
        { filePath: 'src/App.vue', content: generateVueApp(components), role: 'entry' },
        { filePath: 'index.html', content: generateVueIndexHtml(pageTitle), role: 'entry' },
        { filePath: 'src/styles/globals.css', content: generateGlobalsCss(darkMode), role: 'style' },
      );
    } else {
      // html+css+js / svelte — 简化处理
      files.push(
        { filePath: 'index.html', content: generateVanillaHtml(pageTitle, components), role: 'entry' },
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

export const generateBarrelExports = tool({
  description: '为组件目录生成 index.ts barrel re-export 文件，方便统一导入',
  inputSchema: z.object({
    components: z.array(z.object({
      name: z.string().describe('组件名'),
      dirName: z.string().describe('组件目录名（通常与组件名相同）'),
      isDefault: z.boolean().default(true).describe('是否是默认导出'),
    })).describe('需要包含在 barrel 文件中的组件'),
    outputPath: z.string().default('src/components/index.ts').describe('barrel 文件输出路径'),
  }),
  execute: async ({ components, outputPath }) => {
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
      // 计算相对路径
      const currentDir = path.dirname(currentFilePath);
      let relativePath = path.relative(currentDir, target);
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }
      // 去掉扩展名（TypeScript 导入不需要）
      relativePath = relativePath.replace(/\.(tsx?|jsx?|vue|svelte)$/, '');

      const regex = new RegExp(
        `(from\\s+['"])${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`,
        'g',
      );

      if (regex.test(result)) {
        result = result.replace(regex, `$1${relativePath}$2`);
        fixCount++;
      }
    }

    return {
      code: result,
      fixCount,
      instruction: fixCount > 0
        ? `修正了 ${fixCount} 个导入路径`
        : '无需修正导入路径',
    };
  },
});

export const mergeStyles = tool({
  description: '将多个组件的样式合并，支持单文件合并或保持按组件分离',
  inputSchema: z.object({
    styles: z.array(z.object({
      componentName: z.string(),
      content: z.string(),
      fileName: z.string(),
    })).describe('各组件的样式文件'),
    outputStrategy: z.enum(['single-file', 'per-component']).default('per-component').describe('合并策略'),
    outputPath: z.string().optional().describe('single-file 模式下的输出路径'),
  }),
  execute: async ({ styles, outputStrategy, outputPath }) => {
    if (outputStrategy === 'single-file') {
      const merged = styles
        .map((s) => `/* ── ${s.componentName} ── */\n${s.content}`)
        .join('\n\n');
      return {
        files: [{ filePath: outputPath ?? 'styles/components.css', content: merged }],
        strategy: 'single-file',
        totalComponents: styles.length,
      };
    }

    // per-component: 保持独立文件
    return {
      files: styles.map((s) => ({ filePath: s.fileName, content: s.content })),
      strategy: 'per-component',
      totalComponents: styles.length,
    };
  },
});

export const writeProjectToDisk = tool({
  description: '将组装好的完整项目文件写入磁盘目录，自动创建所需的目录结构',
  inputSchema: z.object({
    outputDir: z.string().describe('输出目录的绝对路径'),
    files: z.array(z.object({
      filePath: z.string().describe('相对项目根的路径'),
      content: z.string().describe('文件内容'),
    })).describe('所有需要写入的文件'),
    clean: z.boolean().default(true).describe('写入前是否清空目标目录'),
    directories: z.array(z.string()).optional().default([]).describe('需要预先创建的空目录列表'),
  }),
  execute: async ({ outputDir, files, clean, directories }) => {
    // 清空目标目录
    if (clean) {
      await rm(outputDir, { recursive: true, force: true });
    }

    // 创建空目录
    for (const dir of directories ?? []) {
      await mkdir(path.join(outputDir, dir), { recursive: true });
    }

    // 写入文件
    const writtenPaths: string[] = [];
    for (const file of files) {
      const absPath = path.join(outputDir, file.filePath);
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
