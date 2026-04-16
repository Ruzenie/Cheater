/**
 * code-assembler.ts — 代码组装师 Agent
 *
 * 在代码审计之后运行。将 Code Producer 产出的散乱组件代码 +
 * Project Planner 的项目结构规划，整合成一个完整、可运行的前端项目。
 *
 * 与旧 page-assembler 的区别：
 *   - 输出完整项目（N个文件+目录），而非固定3文件
 *   - 支持所有框架（React/Vue/Svelte/原生），而非仅原生HTML
 *   - 遵循 ProjectStructure 规划的目录结构
 *   - 包含完整配置文件（package.json, tsconfig, vite.config 等）
 *   - `npm install && npm run dev` 直接可运行
 *
 * 模型策略：
 *   - 入口文件生成（App.tsx/main.tsx）→ worker（需理解组件关系）
 *   - 组件放置 / barrel 文件 → 零 LLM 成本（纯文件映射）
 *   - 导入路径修正 → executor（简单文本处理）
 *   - 配置文件 → 零成本（来自 ProjectPlanner 模板）
 */

import { streamText } from 'ai';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import type { CodeProducerResult, CodeOutput } from './code-producer.js';
import type { ProjectStructure, ComponentMapping } from './project-planner.js';

// ── 输出类型 ──────────────────────────────────────────

export interface AssembledFile {
  /** 相对项目根的路径 */
  filePath: string;
  /** 文件内容 */
  content: string;
  /** 来源：模板 / AI生成 / 合并 / 配置 */
  source: 'template' | 'ai-generated' | 'merged' | 'config';
}

export interface AssemblyResult {
  /** 项目名 */
  projectName: string;
  /** 所有输出文件 */
  files: AssembledFile[];
  /** 总文件数 */
  totalFiles: number;
  /** 框架 */
  framework: string;
  /** 主入口文件路径 */
  entryPoint: string;
  /** 安装命令 */
  installCommand: string;
  /** 开发命令 */
  devCommand: string;
  /** 构建命令 */
  buildCommand: string;
  /** 组装过程日志 */
  assemblyLog: string[];
  /** 使用的模型层级 */
  modelTiersUsed: string[];
  /** 是否已写入磁盘 */
  writtenToDisk: boolean;
  /** 输出目录（如果已写入） */
  outputDir?: string;
}

// ── Telemetry ──

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 工具函数 ──────────────────────────────────────

/**
 * 将组件的 artifacts 映射到项目结构中的目标路径
 */
function placeComponentArtifacts(
  component: CodeOutput,
  mapping: ComponentMapping,
): AssembledFile[] {
  const files: AssembledFile[] = [];

  for (const artifact of component.artifacts) {
    files.push({
      filePath: `${mapping.targetDir}/${artifact.fileName}`,
      content: artifact.content,
      source: 'ai-generated',
    });
  }

  return files;
}

/**
 * 生成组件目录的 index.ts barrel re-export
 */
function generateComponentIndex(
  component: CodeOutput,
  mapping: ComponentMapping,
): AssembledFile | null {
  if (mapping.targetDir.includes('html+css+js') || !component.entryFileName) {
    return null;
  }

  const entryName = component.entryFileName.replace(/\.\w+$/, '');
  return {
    filePath: `${mapping.targetDir}/index.ts`,
    content: `export { default } from './${entryName}';\n`,
    source: 'template',
  };
}

/**
 * 生成顶层 components barrel 文件
 */
function generateComponentsBarrel(
  componentMapping: ComponentMapping[],
  componentBaseDir: string,
): AssembledFile {
  const exports = componentMapping
    .map((cm) => `export { default as ${cm.componentName} } from './${cm.componentName}';`)
    .join('\n');

  return {
    filePath: `${componentBaseDir}/index.ts`,
    content: exports + '\n',
    source: 'template',
  };
}

// ── Agent 主函数 ──────────────────────────────────

export async function runCodeAssembler(
  projectStructure: ProjectStructure,
  codeOutput: CodeProducerResult,
  providers: AllProviders,
  options: {
    framework: string;
    styleMethod?: string;
    darkMode?: boolean;
    writeToFS?: boolean;
    outputDir?: string;
    pageTitle?: string;
  } = { framework: 'react' },
): Promise<AssemblyResult> {
  const {
    framework,
    styleMethod = 'tailwind',
    darkMode = false,
    writeToFS = false,
    outputDir,
    pageTitle = projectStructure.projectName,
  } = options;

  const log: string[] = [];
  const tiersUsed: string[] = [];
  const assembledFiles: AssembledFile[] = [];

  console.log('\n🔧 [Code Assembler] 开始组装项目...');
  console.log(`   项目：${projectStructure.projectName}`);
  console.log(`   框架：${projectStructure.framework}`);
  console.log(`   组件数：${codeOutput.totalComponents}`);

  // ── Phase 1: 配置文件（零 LLM 成本）──

  console.log('   📋 Phase 1: 写入配置文件...');

  for (const fileEntry of projectStructure.files) {
    if (fileEntry.templateContent) {
      assembledFiles.push({
        filePath: fileEntry.filePath,
        content: fileEntry.templateContent,
        source: 'config',
      });
      log.push(`✅ 配置文件: ${fileEntry.filePath}`);
    }
  }

  console.log(`   ✅ ${assembledFiles.length} 个配置文件就绪`);

  // ── Phase 2: 组件放置（零 LLM 成本）──

  console.log('   🧩 Phase 2: 放置组件代码...');

  // ── html+css+js 特殊路径：合并成 3 个文件，浏览器直接打开 ──
  if (projectStructure.framework === 'html+css+js') {
    console.log('   📦 原生项目：合并所有组件为 index.html + styles/main.css + scripts/main.js');

    // 收集所有组件的 HTML / CSS / JS
    const allHtml: string[] = [];
    const allCss: string[] = [];
    const allJs: string[] = [];

    for (const component of codeOutput.components) {
      for (const artifact of component.artifacts) {
        const ext = artifact.fileName.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'html') {
          allHtml.push(`    <!-- ═══ ${component.componentName} ═══ -->\n${artifact.content}`);
        } else if (ext === 'css') {
          allCss.push(`/* ═══ ${component.componentName} ═══ */\n${artifact.content}`);
        } else if (ext === 'js') {
          allJs.push(`// ═══ ${component.componentName} ═══\n${artifact.content}`);
        }
      }
      log.push(`✅ 合并组件: ${component.componentName}`);
      console.log(`      🧩 ${component.componentName} → 合并到主文件`);
    }

    // 生成合并后的 index.html
    assembledFiles.push({
      filePath: 'index.html',
      content: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle}</title>
    <link rel="stylesheet" href="./styles/main.css" />
  </head>
  <body>
    <main class="app">
${allHtml.join('\n\n')}
    </main>
    <script src="./scripts/main.js"></script>
  </body>
</html>
`,
      source: 'merged',
    });

    // 生成合并后的 CSS
    assembledFiles.push({
      filePath: 'styles/main.css',
      content: `${generateGlobalsCss(darkMode)}\n\n${allCss.join('\n\n')}`,
      source: 'merged',
    });

    // 生成合并后的 JS（每个组件用 IIFE 隔离作用域，避免变量名冲突）
    assembledFiles.push({
      filePath: 'scripts/main.js',
      content: `'use strict';\n\n${allJs
        .map((js) => {
          // 去掉组件内部重复的 'use strict' 和 @ts-check
          const cleaned = js
            .replace(/^\/\/ ═══.*═══\n/, '') // 先移除分隔注释
            .replace(/['"]use strict['"];?\s*/g, '')
            .replace(/\/\/\s*@ts-check\s*/g, '')
            .trim();
          // 从原始 js 中提取组件名注释
          const header = js.match(/^\/\/ ═══.*═══/)?.[0] ?? '';
          return `${header}\n;(function() {\n${cleaned}\n})();`;
        })
        .join('\n\n')}`,
      source: 'merged',
    });

    log.push(`✅ 合并完成: index.html + styles/main.css + scripts/main.js`);
  } else {
    // ── 框架项目（React/Vue/Svelte）：按组件目录放置 ──

    const componentMap = new Map(
      projectStructure.componentMapping.map((cm) => [cm.componentName, cm]),
    );

    for (const component of codeOutput.components) {
      const mapping = componentMap.get(component.componentName);
      if (!mapping) {
        const fwKey = projectStructure.framework;
        const baseDir = fwKey === 'svelte' ? 'src/lib/components' : 'src/components';

        const fallbackMapping: ComponentMapping = {
          componentName: component.componentName,
          targetPath: `${baseDir}/${component.componentName}/${component.entryFileName}`,
          targetDir: `${baseDir}/${component.componentName}`,
          relatedFiles: [],
          importPath: `./${baseDir.replace('src/', '')}/${component.componentName}`,
          isLayout: false,
        };

        const files = placeComponentArtifacts(component, fallbackMapping);
        assembledFiles.push(...files);

        const indexFile = generateComponentIndex(component, fallbackMapping);
        if (indexFile) assembledFiles.push(indexFile);

        log.push(
          `⚠️ 组件 ${component.componentName} 无映射，放置到默认位置: ${fallbackMapping.targetDir}/`,
        );
        continue;
      }

      const files = placeComponentArtifacts(component, mapping);
      assembledFiles.push(...files);

      const indexFile = generateComponentIndex(component, mapping);
      if (indexFile) assembledFiles.push(indexFile);

      log.push(`✅ 组件: ${component.componentName} → ${mapping.targetDir}/`);
      console.log(`      🧩 ${component.componentName} → ${mapping.targetDir}/`);
    }
  }

  // ── Phase 3: Barrel 文件（零 LLM 成本）──

  if (projectStructure.framework !== 'html+css+js') {
    const componentBaseDir =
      projectStructure.framework === 'svelte' ? 'src/lib/components' : 'src/components';

    const barrel = generateComponentsBarrel(projectStructure.componentMapping, componentBaseDir);
    assembledFiles.push(barrel);
    log.push(`✅ Barrel: ${barrel.filePath}`);
  }

  // ── Phase 4: 入口文件生成（仅框架项目需要，原生项目已在 Phase 2 合并完成）──

  if (projectStructure.framework !== 'html+css+js') {
    console.log('   🏗️  Phase 3: 生成入口文件...');

    tiersUsed.push('worker');
    const componentInfoForEntry = projectStructure.componentMapping.map((cm) => ({
      name: cm.componentName,
      importPath: cm.importPath,
      isLayout: cm.isLayout,
      description:
        codeOutput.components
          .find((c) => c.componentName === cm.componentName)
          ?.artifacts[0]?.content.slice(0, 100) ?? '',
    }));

    const entryStream = streamText({
      model: getWrappedModel('worker', providers),
      system: `你是一个资深前端项目整合架构师。
你的任务是生成项目入口文件，将所有组件正确整合到一起。

框架：${projectStructure.framework}
样式方案：${styleMethod}
${darkMode ? '需要支持暗色模式。' : ''}

你必须输出合法 JSON，格式如下：
{
  "files": [
    {"filePath": "文件路径", "content": "完整文件内容"}
  ]
}

要求：
- 生成框架标准入口文件（${projectStructure.framework === 'react' ? 'src/main.tsx, src/App.tsx, index.html' : projectStructure.framework === 'vue' ? 'src/main.ts, src/App.vue, index.html' : 'src/routes/+page.svelte, src/routes/+layout.svelte, src/app.html'}）
- 正确导入所有组件
- 布局组件（如 NavBar, Footer）放在 App 的外层结构中
- 内容组件放在 main/content 区域
- 全局样式文件中包含 CSS Reset 和基础样式
- 每个文件的 content 必须是完整可用的代码
- 不要输出 JSON 以外的内容`,
      prompt: `项目名：${projectStructure.projectName}
页面标题：${pageTitle}

组件列表：
${componentInfoForEntry.map((c) => `- ${c.name} (${c.isLayout ? '布局' : '内容'}) → import from '${c.importPath}'`).join('\n')}

需求概述：${projectStructure.notes.join('；') || '无额外说明'}`,
      temperature: 0.2,
      maxOutputTokens: 8000,
      experimental_telemetry: telemetryConfig(`code-assembler:entry:${projectStructure.framework}`),
    });

    const entryText = await consumeTextStream(entryStream.textStream, {
      prefix: '      [entry] ',
      echo: false,
    });

    try {
      const raw = safeParseJson(entryText);
      const entryFiles = Array.isArray(raw?.files) ? raw.files : [];

      for (const file of entryFiles) {
        if (typeof file?.filePath === 'string' && typeof file?.content === 'string') {
          assembledFiles.push({
            filePath: file.filePath,
            content: file.content,
            source: 'ai-generated',
          });
          log.push(`✅ 入口文件: ${file.filePath}`);
        }
      }
    } catch {
      console.warn('   ⚠️  入口文件解析失败，使用模板 fallback');
      log.push('⚠️ 入口文件 AI 生成失败，使用模板 fallback');

      // Fallback: 使用简单模板
      const fwKey = projectStructure.framework;
      if (fwKey === 'react') {
        assembledFiles.push(
          {
            filePath: 'index.html',
            content: `<!DOCTYPE html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${pageTitle}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
            source: 'template',
          },
          {
            filePath: 'src/main.tsx',
            content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
            source: 'template',
          },
          {
            filePath: 'src/App.tsx',
            content: `${componentInfoForEntry.map((c) => `import ${c.name} from '${c.importPath}';`).join('\n')}\n\nexport default function App() {\n  return (\n    <div className="app">\n${componentInfoForEntry.map((c) => `      <${c.name} />`).join('\n')}\n    </div>\n  );\n}\n`,
            source: 'template',
          },
        );
      }
    }
  }

  // ── Phase 5: 全局样式（如果入口文件没有生成）──

  const hasGlobalStyle = assembledFiles.some(
    (f) => f.filePath.includes('globals.css') || f.filePath === 'styles/main.css',
  );
  if (!hasGlobalStyle) {
    const stylePath =
      projectStructure.framework === 'html+css+js' ? 'styles/main.css' : 'src/styles/globals.css';
    assembledFiles.push({
      filePath: stylePath,
      content: generateGlobalsCss(darkMode),
      source: 'template',
    });
    log.push(`✅ 全局样式: ${stylePath}`);
  }

  // ── Phase 6: 去重（同路径取最后一个）──

  const fileMap = new Map<string, AssembledFile>();
  for (const file of assembledFiles) {
    fileMap.set(file.filePath, file);
  }
  const dedupedFiles = [...fileMap.values()];

  // ── Phase 7: 写入磁盘（可选）──

  let writtenToDisk = false;
  let finalOutputDir: string | undefined;

  if (writeToFS && outputDir) {
    console.log(`   💾 Phase 4: 写入磁盘 → ${outputDir}`);

    // 安全校验：防止误删重要目录
    const resolvedOut = path.resolve(outputDir);
    const dangerous = ['/', '/usr', '/etc', '/var', '/tmp', '/home', '/root'];
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (
      dangerous.includes(resolvedOut) ||
      resolvedOut === home ||
      resolvedOut.split(path.sep).length <= 2
    ) {
      throw new Error(`❌ 拒绝删除危险路径: ${resolvedOut}`);
    }
    await rm(outputDir, { recursive: true, force: true });

    // 创建目录
    for (const dir of projectStructure.directories) {
      await mkdir(path.join(outputDir, dir), { recursive: true });
    }

    // 写入文件
    for (const file of dedupedFiles) {
      const absPath = path.join(outputDir, file.filePath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, file.content, 'utf8');
    }

    writtenToDisk = true;
    finalOutputDir = outputDir;
    log.push(`💾 已写入 ${dedupedFiles.length} 个文件到 ${outputDir}`);
    console.log(`   ✅ ${dedupedFiles.length} 个文件已写入磁盘`);
  }

  // ── 总结 ──

  const entryPoint =
    projectStructure.framework === 'html+css+js'
      ? 'index.html'
      : projectStructure.framework === 'svelte'
        ? 'src/routes/+page.svelte'
        : projectStructure.framework === 'vue'
          ? 'src/main.ts'
          : 'src/main.tsx';

  console.log(`\n🔧 [Code Assembler] 组装完成！`);
  console.log(`   📦 项目：${projectStructure.projectName}`);
  console.log(`   📄 文件数：${dedupedFiles.length}`);
  console.log(`   🚀 入口：${entryPoint}`);
  console.log(`   📝 ${projectStructure.installCommand} && ${projectStructure.devCommand}`);
  if (writtenToDisk) {
    console.log(`   💾 输出：${finalOutputDir}`);
  }
  console.log('');

  return {
    projectName: projectStructure.projectName,
    files: dedupedFiles,
    totalFiles: dedupedFiles.length,
    framework: projectStructure.framework,
    entryPoint,
    installCommand: projectStructure.installCommand,
    devCommand: projectStructure.devCommand,
    buildCommand: projectStructure.buildCommand,
    assemblyLog: log,
    modelTiersUsed: tiersUsed,
    writtenToDisk,
    outputDir: finalOutputDir,
  };
}

// ── 内部工具函数（导出供 tools/assembly 使用）──

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
}img,
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
