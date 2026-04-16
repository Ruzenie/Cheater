/**
 * page-assembler.ts — 使用 reasoner 增量组装页面骨架与独立资源文件。
 *
 * @deprecated 请使用 code-assembler.ts + project-planner.ts 替代。
 * page-assembler 仅输出固定的 3 个文件（index.html/page.css/page.js），
 * 新的 Code Assembler 可以输出完整的项目结构。
 * 保留此文件仅为向后兼容。
 */

import { streamText } from 'ai';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import type { CodeOutput } from './code-producer.js';

export interface AssembledAsset {
  fileName: string;
  content: string;
}

export interface AssembledPageResult {
  assets: AssembledAsset[];
  source: 'reasoner' | 'fallback';
}

export interface AssemblyAppendOptions {
  framework: string;
  pageTitle?: string;
}

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

function buildAssetJsonRule(assetNames: string[]): string {
  return `你必须输出合法 JSON，格式如下：
{
  "assets": [
${assetNames.map((name) => `    {"fileName": "${name}", "content": "完整文件内容"}`).join(',\n')}
  ]
}

要求：
- 只能输出以上文件名
- 每个 content 必须是完整文件内容
- 不要输出 JSON 以外的任何内容`;
}

function parseAssets(text: string, fallbackAssets: AssembledAsset[]): AssembledAsset[] {
  try {
    const raw = safeParseJson(text);
    const fallbackMap = new Map(fallbackAssets.map((asset) => [asset.fileName, asset.content]));
    const parsed = Array.isArray(raw?.assets) ? raw.assets : [];
    const normalized = parsed
      .map((asset: any) => {
        const fileName = typeof asset?.fileName === 'string' ? asset.fileName : '';
        const content = typeof asset?.content === 'string' ? asset.content : '';
        if (!fileName || !content || !fallbackMap.has(fileName)) {
          return null;
        }
        return { fileName, content };
      })
      .filter((asset: AssembledAsset | null): asset is AssembledAsset => asset !== null);

    return normalized.length === fallbackAssets.length ? normalized : fallbackAssets;
  } catch {
    return fallbackAssets;
  }
}

function buildFallbackAssets(
  requirement: string,
  components: CodeOutput[],
  pageTitle: string,
): AssembledAsset[] {
  const bodySections = components
    .map((component) => {
      const htmlArtifacts = component.artifacts.filter((artifact) =>
        artifact.fileName.endsWith('.html'),
      );
      return htmlArtifacts
        .map(
          (artifact) =>
            `<section data-section="${component.componentName}">\n${artifact.content}\n</section>`,
        )
        .join('\n');
    })
    .join('\n\n');

  const cssContent = components
    .flatMap((component) =>
      component.artifacts.filter((artifact) => artifact.fileName.endsWith('.css')),
    )
    .map((artifact) => artifact.content)
    .join('\n\n');

  const jsContent = components
    .flatMap((component) =>
      component.artifacts.filter((artifact) => artifact.fileName.endsWith('.js')),
    )
    .map((artifact) => artifact.content)
    .join('\n\n');

  return [
    {
      fileName: 'index.html',
      content: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle}</title>
    <link rel="stylesheet" href="./page.css" />
  </head>
  <body>
    <main class="assembled-page">
      <header class="assembled-page__header">
        <h1>${pageTitle}</h1>
        <p>${requirement}</p>
      </header>
${bodySections || '      <p>暂无可组装内容。</p>'}
    </main>
    <script src="./page.js"></script>
  </body>
</html>`,
    },
    {
      fileName: 'page.css',
      content: `.assembled-page {\n  width: min(1200px, calc(100% - 32px));\n  margin: 0 auto;\n  padding: 24px 0 48px;\n}\n\n.assembled-page__header {\n  margin-bottom: 24px;\n}\n\n${cssContent || 'body { font-family: sans-serif; margin: 0; padding: 24px; }'}`,
    },
    {
      fileName: 'page.js',
      content: `${jsContent || '// no-op'}\n`,
    },
  ];
}

export async function initializePageAssembly(
  requirement: string,
  providers: AllProviders,
  options: {
    framework: string;
    pageTitle?: string;
  },
): Promise<AssembledPageResult> {
  const { framework, pageTitle = 'Generated Page' } = options;

  console.log('\n🧠 [Page Assembler] 初始化页面骨架...');

  const fallbackAssets = [
    {
      fileName: 'index.html',
      content: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle}</title>
    <link rel="stylesheet" href="./page.css" />
  </head>
  <body>
    <main class="assembled-page">
      <header class="assembled-page__header">
        <h1>${pageTitle}</h1>
        <p>${requirement}</p>
      </header>
      <section class="assembled-page__content" data-slot="components"></section>
    </main>
    <script src="./page.js"></script>
  </body>
</html>`,
    },
    {
      fileName: 'page.css',
      content: `.assembled-page {\n  width: min(1200px, calc(100% - 32px));\n  margin: 0 auto;\n  padding: 24px 0 48px;\n}\n\n.assembled-page__header {\n  margin-bottom: 24px;\n}\n\n.assembled-page__content {\n  display: grid;\n  gap: 24px;\n}\n`,
    },
    {
      fileName: 'page.js',
      content: '// page assembly runtime\n',
    },
  ];

  const stream = streamText({
    model: getWrappedModel('reasoner', providers),
    system: `你是一个高级前端页面架构师。

你的任务是先建立一个完整页面骨架，后续其他组件会不断拼接进来。

要求：
- 目标框架：${framework}
- 产物固定为 3 个独立文件：index.html / page.css / page.js
- HTML 必须引用外部 CSS/JS，不要内联
- HTML 中要预留一个组件插槽区域，后续可持续插入组件
- CSS 只保留页面骨架级样式
- JS 只保留页面级初始化逻辑

${buildAssetJsonRule(fallbackAssets.map((asset) => asset.fileName))}`,
    prompt: `原始需求：
${requirement}

页面标题：${pageTitle}

请先生成可持续增量拼装的页面骨架。`,
    temperature: 0.2,
    maxOutputTokens: 8000,
    experimental_telemetry: telemetryConfig(`page-assembler:init:${framework}`),
  });

  const text = await consumeTextStream(stream.textStream, { prefix: '      [page-init] ' });
  const assets = parseAssets(text, fallbackAssets);
  return {
    assets,
    source: assets === fallbackAssets ? 'fallback' : 'reasoner',
  };
}

export async function assemblePageIncrementally(
  requirement: string,
  components: CodeOutput[],
  providers: AllProviders,
  options: AssemblyAppendOptions,
): Promise<AssembledPageResult> {
  const { framework, pageTitle = 'Generated Page' } = options;

  let assembly = await initializePageAssembly(requirement, providers, options);

  for (const component of components) {
    console.log(`\n🧠 [Page Assembler] 增量拼装组件: ${component.componentName}`);

    const componentText = component.artifacts
      .map((artifact) => `## FILE: ${artifact.fileName}\n${artifact.content}`)
      .join('\n\n');
    const fallbackAssets = buildFallbackAssets(
      requirement,
      components.slice(0, components.indexOf(component) + 1),
      pageTitle,
    );

    const stream = streamText({
      model: getWrappedModel('reasoner', providers),
      system: `你是一个高级前端整合架构师。

现在你已经有一套页面骨架（index.html / page.css / page.js），需要把新生成的组件继续拼接进去。

要求：
- 产物仍然固定为 3 个独立文件：index.html / page.css / page.js
- 将组件真实整合进页面，不要只附加说明文字
- 允许把组件 CSS 合并到 page.css
- 允许把组件 JS 合并到 page.js，但要注意作用域与重复监听
- 组件之间要形成完整页面结构，而不是互不关联的片段陈列

${buildAssetJsonRule(assembly.assets.map((asset) => asset.fileName))}`,
      prompt: `原始需求：
${requirement}

页面标题：${pageTitle}

当前页面骨架：
${assembly.assets.map((asset) => `# FILE: ${asset.fileName}\n${asset.content}`).join('\n\n')}

新组件产物：
${componentText}

请把新组件拼接进现有页面骨架，并返回更新后的 3 个完整文件。`,
      temperature: 0.2,
      maxOutputTokens: 12000,
      experimental_telemetry: telemetryConfig(
        `page-assembler:append:${framework}:${component.componentName}`,
      ),
    });

    const text = await consumeTextStream(stream.textStream, {
      prefix: `      [page-append:${component.componentName}] `,
    });
    const nextAssets = parseAssets(text, fallbackAssets);
    assembly = {
      assets: nextAssets,
      source: nextAssets === fallbackAssets ? 'fallback' : 'reasoner',
    };
  }

  return assembly;
}

export async function appendComponentToAssembly(
  requirement: string,
  currentAssembly: AssembledPageResult,
  component: CodeOutput,
  processedComponents: CodeOutput[],
  providers: AllProviders,
  options: AssemblyAppendOptions,
): Promise<AssembledPageResult> {
  const { framework, pageTitle = 'Generated Page' } = options;

  console.log(`\n🧠 [Page Assembler] 增量拼装组件: ${component.componentName}`);

  const componentText = component.artifacts
    .map((artifact) => `## FILE: ${artifact.fileName}\n${artifact.content}`)
    .join('\n\n');
  const fallbackAssets = buildFallbackAssets(requirement, processedComponents, pageTitle);

  const stream = streamText({
    model: getWrappedModel('reasoner', providers),
    system: `你是一个高级前端整合架构师。

现在你已经有一套页面骨架（index.html / page.css / page.js），需要把新生成的组件继续拼接进去。

要求：
- 产物仍然固定为 3 个独立文件：index.html / page.css / page.js
- 将组件真实整合进页面，不要只附加说明文字
- 允许把组件 CSS 合并到 page.css
- 允许把组件 JS 合并到 page.js，但要注意作用域与重复监听
- 组件之间要形成完整页面结构，而不是互不关联的片段陈列

${buildAssetJsonRule(currentAssembly.assets.map((asset) => asset.fileName))}`,
    prompt: `原始需求：
${requirement}

页面标题：${pageTitle}

当前页面骨架：
${currentAssembly.assets.map((asset) => `# FILE: ${asset.fileName}\n${asset.content}`).join('\n\n')}

新组件产物：
${componentText}

请把新组件拼接进现有页面骨架，并返回更新后的 3 个完整文件。`,
    temperature: 0.2,
    maxOutputTokens: 12000,
    experimental_telemetry: telemetryConfig(
      `page-assembler:append:${framework}:${component.componentName}`,
    ),
  });

  const text = await consumeTextStream(stream.textStream, {
    prefix: `      [page-append:${component.componentName}] `,
  });
  const nextAssets = parseAssets(text, fallbackAssets);

  return {
    assets: nextAssets,
    source: nextAssets === fallbackAssets ? 'fallback' : 'reasoner',
  };
}
