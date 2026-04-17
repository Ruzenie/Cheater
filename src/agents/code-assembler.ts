/**
 * code-assembler.ts — 代码组装师 Agent
 *
 * 在代码审计之后运行。将 Code Producer 产出的散乱组件代码 +
 * Project Planner 的项目结构规划，整合成一个完整、可运行的前端项目。
 *
 * 在流水线中的位置：
 *   Step 6: orchestrator 在代码审计（Step 5）通过后调用本模块
 *   输入来自 project-planner（目录结构+配置文件）和 code-producer（组件代码）
 *   输出为可直接 `npm install && npm run dev` 运行的完整项目
 *
 * 与旧 page-assembler 的区别：
 *   - 输出完整项目（N个文件+目录），而非固定3文件
 *   - 支持所有框架（React/Vue/Svelte/原生），而非仅原生HTML
 *   - 遵循 ProjectStructure 规划的目录结构
 *   - 包含完整配置文件（package.json, tsconfig, vite.config 等）
 *   - `npm install && npm run dev` 直接可运行
 *
 * 两条组装路径：
 *   1. Vanilla 路径（html+css+js）：将所有组件合并为 index.html + styles/main.css + scripts/main.js
 *      - stripHtmlDocumentShell：剥离 LLM 可能输出的完整 HTML 文档壳
 *      - cleanComponentCss：移除组件 CSS 中的全局重置和冲突声明
 *      - detectConflicts：检测跨组件的 ID/类名冲突
 *      - JS 用 IIFE 包裹避免变量名冲突
 *   2. 框架路径（React/Vue/Svelte）：按目录放置组件 + 生成 barrel + AI 生成入口文件
 *
 * 模型策略：
 *   - 入口文件生成（App.tsx/main.tsx）→ worker（需理解组件关系）
 *   - 组件放置 / barrel 文件 → 零 LLM 成本（纯文件映射）
 *   - 导入路径修正 → executor（简单文本处理）
 *   - 配置文件 → 零成本（来自 ProjectPlanner 模板）
 *
 * 输入类型：
 *   @param projectStructure - ProjectStructure（来自 project-planner）
 *   @param codeOutput       - CodeProducerResult（来自 code-producer）
 *
 * 输出类型：
 *   @returns AssemblyResult - 包含所有组装后的文件、运行命令、写磁盘状态
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

/**
 * 组装后的单个文件。
 * 每个文件记录其相对路径、内容和来源方式，便于调试和追溯。
 */
export interface AssembledFile {
  /** 相对项目根的路径 */
  filePath: string;
  /** 文件内容 */
  content: string;
  /** 来源：模板 / AI生成 / 合并 / 配置 */
  source: 'template' | 'ai-generated' | 'merged' | 'config';
}

/**
 * 代码组装的最终输出结构。
 * 包含项目所有文件、运行命令、框架信息和磁盘写入状态。
 */
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

// ── Telemetry 配置 ──────────────────────────────────

/**
 * 构建 telemetry 配置对象，用于追踪每个 LLM 调用的耗时和 token 消耗。
 *
 * @param functionId - 调用标识符，格式为 `code-assembler:<阶段>:<框架>`
 * @returns AI SDK 的 experimental_telemetry 配置
 */
function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 工具函数 ──────────────────────────────────────

/**
 * 将组件的 artifacts 映射到项目结构中的目标路径。
 * 每个 artifact 文件放到 mapping 指定的目标目录下，来源标记为 AI 生成。
 *
 * @param component - 单个组件的代码产出（包含多个文件 artifacts）
 * @param mapping   - 该组件的目录映射信息（来自 ProjectPlanner）
 * @returns 映射后的 AssembledFile 数组
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
 * 生成组件目录的 index.ts barrel re-export 文件。
 * 使 import 语句可以省略文件名（如 `import Foo from './components/Foo'`）。
 * 原生 HTML 项目不需要 barrel 文件，返回 null。
 *
 * @param component - 单个组件的代码产出
 * @param mapping   - 该组件的目录映射信息
 * @returns barrel 文件，或 null（原生项目/无入口文件时）
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
 * 生成顶层 components 目录的 barrel 文件。
 * 将所有组件通过 `export { default as Xxx }` 统一导出，
 * 方便入口文件（App.tsx）一行导入多个组件。
 *
 * @param componentMapping - 所有组件的映射信息数组
 * @param componentBaseDir - 组件根目录路径（如 `src/components`）
 * @returns 顶层 barrel 文件
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

// ── Vanilla 组件清理工具 ──────────────────────────────────

/**
 * 从组件 HTML 中剥离文档级标签，只保留可嵌入的片段内容。
 * 处理 LLM 不遵守 prompt 约束、输出完整 HTML 文档的情况。
 *
 * 清理逻辑：
 *   1. 移除 <!DOCTYPE> 声明
 *   2. 如有 <body>，提取 body 内容
 *   3. 移除残留的 <html>/<head>/<meta>/<title> 标签
 *   4. 移除外部 CDN <link> 和 <script src> 标签（保留内联内容）
 *
 * @param html - 可能包含文档级标签的组件 HTML
 * @returns 仅包含可嵌入片段的清理后 HTML
 */
function stripHtmlDocumentShell(html: string): string {
  let content = html;

  // 移除 <!DOCTYPE ...>
  content = content.replace(/<!DOCTYPE[^>]*>/gi, '');

  // 如果包含 <body>，提取 body 内容
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  }

  // 移除残留的 <html>, </html>, <head>...</head>, <meta>, <title>, <link rel="stylesheet">
  content = content.replace(/<\/?html[^>]*>/gi, '');
  content = content.replace(/<head[\s\S]*?<\/head>/gi, '');
  content = content.replace(/<meta[^>]*\/?>/gi, '');
  content = content.replace(/<title[\s\S]*?<\/title>/gi, '');
  // 移除外部 CDN link 标签（保留内联 style）
  content = content.replace(/<link\s[^>]*rel=["']stylesheet["'][^>]*\/?>/gi, '');
  // 移除外部 script src 标签（保留内联 script）
  content = content.replace(/<script\s[^>]*src=["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

  return content.trim();
}

/**
 * 清理组件 CSS，移除全局重置和冲突性声明。
 * 由 assembler 统一提供全局重置，组件不应该自行添加。
 *
 * 清理规则：
 *   1. 移除 `* { ... }` 全局重置块
 *   2. 移除 `body { ... }` 和 `html { ... }` 选择器块
 *   3. 移除独立的媒体元素（img/video/svg 等）全局重置
 *   4. 移除表单元素（input/button 等）的 `font: inherit` 重置
 *   5. 检测 :root 中是否有通用变量名可能与其他组件冲突（如 --bg、--primary）
 *
 * @param css           - 组件的原始 CSS 文本
 * @param componentName - 组件名（用于变量名冲突检测的前缀匹配）
 * @returns 清理后的 CSS 文本
 */
function cleanComponentCss(css: string, componentName: string): string {
  let cleaned = css;

  // 移除 * { ... } 全局重置块（通常包含 margin:0, padding:0, box-sizing）
  cleaned = cleaned.replace(
    /(?:^|\n)\s*\*\s*(?:,\s*\*::before\s*,\s*\*::after\s*)?\{[^}]*\}\s*/g,
    '\n',
  );

  // 移除 body { ... } 和 html { ... } 选择器块
  cleaned = cleaned.replace(/(?:^|\n)\s*(?:body|html)\s*\{[^}]*\}\s*/g, '\n');

  // 移除独立的 img, picture, video, canvas, svg 全局重置
  cleaned = cleaned.replace(
    /(?:^|\n)\s*(?:img|picture|video|canvas|svg)\s*(?:,\s*(?:img|picture|video|canvas|svg)\s*)*\{[^}]*\}\s*/g,
    '\n',
  );

  // 移除 input, button, textarea, select 全局重置
  cleaned = cleaned.replace(
    /(?:^|\n)\s*(?:input|button|textarea|select)\s*(?:,\s*(?:input|button|textarea|select)\s*)*\{[^}]*font:\s*inherit[^}]*\}\s*/g,
    '\n',
  );

  // 正则匹配 :root 块内定义的 CSS 自定义属性，检查是否使用了通用前缀名
  // 如 --bg、--primary 等可能与其他组件冲突的变量名
  const rootMatches = [...cleaned.matchAll(/:root\s*\{([^}]*)\}/g)];
  if (rootMatches.length > 0) {
    const vars = rootMatches.flatMap((m) => [...m[1].matchAll(/--([\w-]+)\s*:/g)].map((v) => v[1]));
    // 将组件名转为 kebab-case，用于判断变量名是否以组件名为前缀（有前缀则安全）
    const kebabName = componentName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    // 筛选出不以组件名为前缀、且使用了通用语义名（bg/text/primary 等）的变量
    const genericVars = vars.filter(
      (v) =>
        !v.startsWith(kebabName) &&
        /^(bg|text|border|accent|shadow|error|success|info|primary|secondary)/.test(v),
    );
    if (genericVars.length > 0) {
      console.warn(
        `   ⚠️  组件 ${componentName} 的 CSS 包含可能冲突的通用变量名: ${genericVars
          .slice(0, 5)
          .map((v) => `--${v}`)
          .join(', ')}${genericVars.length > 5 ? ` 等 ${genericVars.length} 个` : ''}`,
      );
    }
  }

  // 清理多余空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 检测所有组件中的 ID 和类名冲突，输出警告日志。
 * 在 Vanilla 路径中，多个组件合并到同一个 HTML/CSS 文件，
 * 如果存在重复的 `id` 或 `.className`，会导致样式和行为混乱。
 *
 * 检测方式：
 *   - 用正则从 HTML 中提取所有 `id="xxx"` 属性值
 *   - 用正则从 CSS 中提取所有 `.className` 选择器
 *   - 对同一 ID/类名出现在多个组件中的情况发出警告
 *
 * @param components - 所有组件的代码产出数组
 */
function detectConflicts(components: CodeOutput[]): void {
  const idMap = new Map<string, string[]>();
  const classMap = new Map<string, string[]>();

  for (const component of components) {
    for (const artifact of component.artifacts) {
      if (artifact.fileName.endsWith('.html')) {
    // 正则从 HTML 属性中提取所有 id 值（如 id="myId" 或 id='myId'）
    const ids = [...artifact.content.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
        for (const id of ids) {
          if (!idMap.has(id)) idMap.set(id, []);
          idMap.get(id)!.push(component.componentName);
        }
      }
      if (artifact.fileName.endsWith('.css')) {
        const classes = [...artifact.content.matchAll(/(?:^|\n)\s*\.([a-z][\w-]*)\s*[{,]/g)].map(
          (m) => m[1],
        );
        for (const cls of classes) {
          if (!classMap.has(cls)) classMap.set(cls, []);
          classMap.get(cls)!.push(component.componentName);
        }
      }
    }
  }

  for (const [id, owners] of idMap) {
    const unique = [...new Set(owners)];
    if (unique.length > 1) {
      console.warn(`   ⚠️  ID 冲突: #${id} 在 ${unique.join(', ')} 中重复出现`);
    }
  }

  for (const [cls, owners] of classMap) {
    const unique = [...new Set(owners)];
    if (unique.length > 1) {
      console.warn(`   ⚠️  类名冲突: .${cls} 在 ${unique.join(', ')} 中重复出现`);
    }
  }
}

// ── Agent 主函数 ──────────────────────────────────

/**
 * 代码组装师主函数 — 将散乱的组件代码和项目规划合并为可运行项目。
 *
 * 执行流程（7 个 Phase）：
 *   Phase 1: 写入配置文件（package.json/tsconfig/vite.config 等，零 LLM 成本）
 *   Phase 2: 放置组件代码（Vanilla 走合并路径，框架走目录放置路径）
 *   Phase 3: 生成 barrel 文件（仅框架项目，零 LLM 成本）
 *   Phase 4: AI 生成入口文件（App.tsx/main.tsx 等，worker 模型）
 *   Phase 5: 补充全局样式（如果入口文件未包含）
 *   Phase 6: 文件去重（同路径取最后一个，后生成的覆盖先生成的）
 *   Phase 7: 可选写入磁盘（带危险路径安全校验）
 *
 * @param projectStructure - 项目结构规划（来自 runProjectPlanner）
 * @param codeOutput       - 代码生成结果（来自 runCodeProducer）
 * @param providers        - LLM 提供商配置
 * @param options          - 框架、样式、暗色模式、输出目录等配置
 * @returns 组装结果，包含所有文件内容和运行命令
 */
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

    // 先检测跨组件冲突
    detectConflicts(codeOutput.components);

    // 收集所有组件的 HTML / CSS / JS（带清理）
    const allHtml: string[] = [];
    const allCss: string[] = [];
    const allJs: string[] = [];

    for (const component of codeOutput.components) {
      for (const artifact of component.artifacts) {
        const ext = artifact.fileName.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'html') {
          // 剥离 LLM 可能输出的完整 HTML 文档壳
          const cleaned = stripHtmlDocumentShell(artifact.content);
          if (cleaned !== artifact.content) {
            console.warn(
              `   ⚠️  组件 ${component.componentName} 的 HTML 包含文档级标签，已自动清理`,
            );
          }
          allHtml.push(`    <!-- ═══ ${component.componentName} ═══ -->\n${cleaned}`);
        } else if (ext === 'css') {
          // 清理全局重置和冲突性声明
          const cleaned = cleanComponentCss(artifact.content, component.componentName);
          allCss.push(`/* ═══ ${component.componentName} ═══ */\n${cleaned}`);
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
    // 构建组件名 → 映射信息的快速查找表
    const componentMap = new Map(
      projectStructure.componentMapping.map((cm) => [cm.componentName, cm]),
    );

    for (const component of codeOutput.components) {
      const mapping = componentMap.get(component.componentName);
      // 当 ProjectPlanner 没有为该组件生成映射时（可能是 AI 规划遗漏），
      // 使用框架默认的组件目录作为兜底路径
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
      const raw = safeParseJson(entryText) as Record<string, unknown>;
      const entryFiles = Array.isArray(raw?.files)
        ? (raw.files as Array<Record<string, unknown>>)
        : [];

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

    // 安全校验：防止误删重要目录（/, /usr, /home, 用户主目录等）
    // 检查路径深度 ≤ 2 也会被拦截（如 /foo）
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

/**
 * 生成全局 CSS 重置样式。
 * 包含 box-sizing 重置、系统字体栈、视口最小高度、媒体元素和表单元素的基础样式。
 * 当 darkMode 为 true 时，额外生成 `prefers-color-scheme: dark` 媒体查询。
 *
 * @param darkMode - 是否包含暗色模式支持
 * @returns 完整的全局 CSS 文本
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
