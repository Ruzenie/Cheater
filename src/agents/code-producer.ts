/**
 * code-producer.ts — 代码制作 Agent（v3 — 可插拔生成器架构）
 */

import { streamText } from 'ai';
import { getWrappedModel, type AllProviders, type ModelTier } from '../config/index.js';
import { getCodeGenerator } from '../generators/index.js';
import type { GeneratedArtifact } from '../generators/types.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import type { ComponentSpec } from '../tools/design/index.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';

export interface CodeOutput {
  componentName: string;
  entryFileName: string;
  artifacts: GeneratedArtifact[];
  generatorId: string;
  selfReviewResult: {
    passed: boolean;
    issues: Array<{ check: string; severity: string; message: string }>;
  };
  modelTiersUsed: ModelTier[];
}

export interface CodeProducerResult {
  components: CodeOutput[];
  totalComponents: number;
  allPassed: boolean;
}

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

function artifactsToText(artifacts: GeneratedArtifact[]): string {
  return artifacts
    .map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`)
    .join('\n\n');
}

function buildArtifactsJsonRule(artifacts: GeneratedArtifact[]): string {
  const fileLines = artifacts
    .map((artifact) => `    {"fileName": "${artifact.fileName}", "content": "完整文件内容"}`)
    .join(',\n');

  return `你必须输出合法 JSON，格式如下：
{
  "files": [
${fileLines}
  ]
}

要求：
- fileName 必须严格保持为给定文件名
- content 必须是完整文件内容
- 不要输出 JSON 以外的任何内容`;
}

function normalizeArtifacts(
  raw: Record<string, unknown>,
  fallbackArtifacts: GeneratedArtifact[],
): GeneratedArtifact[] {
  const fallbackMap = new Map(fallbackArtifacts.map((artifact) => [artifact.fileName, artifact]));

  const rawFiles = raw?.files;
  const fileList: unknown[] = Array.isArray(rawFiles)
    ? rawFiles
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([fileName, content]) => ({ fileName, content }))
      : [];

  const normalized = fileList
    .map((file: unknown) => {
      const f = file as Record<string, unknown> | undefined;
      const fileName = typeof f?.fileName === 'string' ? f.fileName : '';
      const content =
        typeof f?.content === 'string' ? f.content : typeof file === 'string' ? file : '';
      const fallback = fallbackMap.get(fileName);

      if (!fileName || !content || !fallback) {
        return null;
      }

      return {
        fileName,
        content,
        role: fallback.role,
      } satisfies GeneratedArtifact;
    })
    .filter(
      (artifact: GeneratedArtifact | null): artifact is GeneratedArtifact => artifact !== null,
    );

  return normalized.length > 0 ? normalized : fallbackArtifacts;
}

function parseArtifacts(text: string, fallbackArtifacts: GeneratedArtifact[]): GeneratedArtifact[] {
  try {
    const raw = safeParseJson(text) as Record<string, unknown>;
    const result = normalizeArtifacts(raw, fallbackArtifacts);
    // 如果 normalizeArtifacts 返回了 fallback（即解析出的内容为空），发出警告
    if (result === fallbackArtifacts) {
      console.warn(
        '      ⚠️  parseArtifacts: AI 输出解析为空，回退到骨架代码（可能 maxOutputTokens 不足导致 JSON 被截断）',
      );
    }
    return result;
  } catch {
    console.warn(
      '      ⚠️  parseArtifacts: JSON 解析失败，回退到骨架代码（可能 maxOutputTokens 不足导致 JSON 被截断）',
    );
    return fallbackArtifacts;
  }
}

function runSelfReview(
  artifacts: GeneratedArtifact[],
  generatorId: string,
): {
  passed: boolean;
  issues: Array<{ check: string; severity: string; message: string }>;
} {
  const issues: Array<{ check: string; severity: string; message: string }> = [];
  const combined = artifactsToText(artifacts);

  if (generatorId === 'react') {
    if (!combined.includes('interface') && !combined.includes('type ')) {
      issues.push({
        check: 'typescript',
        severity: 'warning',
        message: 'React 生成结果缺少 Props 类型定义',
      });
    }
    if (/:\s*any\b/.test(combined)) {
      issues.push({
        check: 'typescript',
        severity: 'warning',
        message: '存在 any 类型，应使用具体类型',
      });
    }
  }

  if (generatorId === 'vue') {
    if (!artifacts.some((artifact) => artifact.fileName.endsWith('.vue'))) {
      issues.push({
        check: 'structure',
        severity: 'warning',
        message: 'Vue 生成结果缺少 .vue 文件',
      });
    }
    if (/import\s+React|useState\(|className=|on:click|<script>\s*export let/.test(combined)) {
      issues.push({
        check: 'framework',
        severity: 'critical',
        message: 'Vue 生成结果中混入了非 Vue 语法痕迹',
      });
    }
  }

  if (generatorId === 'svelte') {
    if (!artifacts.some((artifact) => artifact.fileName.endsWith('.svelte'))) {
      issues.push({
        check: 'structure',
        severity: 'warning',
        message: 'Svelte 生成结果缺少 .svelte 文件',
      });
    }
    if (/import\s+React|defineProps\(|className=|<template>|<script setup/.test(combined)) {
      issues.push({
        check: 'framework',
        severity: 'critical',
        message: 'Svelte 生成结果中混入了非 Svelte 语法痕迹',
      });
    }
  }

  if (generatorId === 'html+css+js') {
    if (
      /import\s+React|React\.|useState\(|useEffect\(|className=|<\/?[A-Z][A-Za-z0-9]*/.test(
        combined,
      )
    ) {
      issues.push({
        check: 'framework',
        severity: 'critical',
        message: '原生生成结果中混入了 React / JSX 痕迹',
      });
    }
    if (!artifacts.some((artifact) => artifact.fileName.endsWith('.html'))) {
      issues.push({
        check: 'structure',
        severity: 'warning',
        message: '原生生成结果缺少 HTML 文件',
      });
    }
  }

  if (combined.includes('fetch(') && !combined.includes('catch')) {
    issues.push({
      check: 'error-handling',
      severity: 'critical',
      message: 'fetch 调用缺少错误处理',
    });
  }
  if (combined.includes('async') && !combined.includes('try')) {
    issues.push({
      check: 'error-handling',
      severity: 'warning',
      message: '异步操作缺少 try-catch',
    });
  }

  const singleLetterVars = combined.match(/(?:const|let|var)\s+([a-z])\s*=/g) ?? [];
  if (singleLetterVars.length > 0) {
    issues.push({ check: 'naming', severity: 'info', message: '存在单字母变量名' });
  }

  for (const artifact of artifacts) {
    const lines = artifact.content.split('\n').length;
    if (lines > 240) {
      issues.push({
        check: 'structure',
        severity: 'warning',
        message: `${artifact.fileName} 过长 (${lines} 行)，建议拆分`,
      });
    }
  }

  return {
    passed: issues.filter((issue) => issue.severity === 'critical').length === 0,
    issues,
  };
}

async function generateSingleComponent(
  spec: ComponentSpec,
  providers: AllProviders,
  options: { framework: string; styleMethod: string; darkMode: boolean },
): Promise<CodeOutput> {
  const generator = getCodeGenerator(options.framework);
  const tiersUsed: ModelTier[] = [];

  console.log(`      🧩 ${spec.name} 使用生成器: ${generator.displayName}`);

  tiersUsed.push('executor');
  let currentArtifacts = generator.createScaffold(spec, options);

  tiersUsed.push('worker');
  const fillStream = streamText({
    model: getWrappedModel('worker', providers),
    system: `${generator.buildFillSystem(options)}\n\n${buildArtifactsJsonRule(currentArtifacts)}`,
    prompt: generator.buildFillPrompt(spec, currentArtifacts, options),
    temperature: 0.3,
    maxOutputTokens: 8000,
    experimental_telemetry: telemetryConfig(`code-producer:fill:${generator.id}:${spec.name}`),
  });
  const filledText = await consumeTextStream(fillStream.textStream, {
    prefix: `      [fill:${spec.name}] `,
    echo: false,
  });
  currentArtifacts = parseArtifacts(filledText, currentArtifacts);

  if (generator.supportsStylePass(options)) {
    tiersUsed.push('executor');
    const styleStream = streamText({
      model: getWrappedModel('executor', providers),
      system: `${generator.buildStyleSystem(options)}\n\n${buildArtifactsJsonRule(currentArtifacts)}`,
      prompt: generator.buildStylePrompt(spec, currentArtifacts, options),
      temperature: 0.2,
      maxOutputTokens: 8000,
      experimental_telemetry: telemetryConfig(`code-producer:style:${generator.id}:${spec.name}`),
    });
    const styledText = await consumeTextStream(styleStream.textStream, {
      prefix: `      [style:${spec.name}] `,
      echo: false,
    });
    currentArtifacts = parseArtifacts(styledText, currentArtifacts);
  }

  const reviewResult = runSelfReview(currentArtifacts, generator.id);

  if (!reviewResult.passed) {
    console.log(`      ⚠️  ${spec.name} 自检发现问题，升级到 reasoner 修复...`);
    tiersUsed.push('reasoner');

    const fixStream = streamText({
      model: getWrappedModel('reasoner', providers),
      system: `你是高级代码审查员。请修复问题后返回完整文件集合。\n\n${buildArtifactsJsonRule(currentArtifacts)}`,
      prompt: generator.buildFixPrompt(spec, currentArtifacts, reviewResult.issues, options),
      temperature: 0.1,
      maxOutputTokens: 8000,
      experimental_telemetry: telemetryConfig(`code-producer:fix:${generator.id}:${spec.name}`),
    });
    const fixedText = await consumeTextStream(fixStream.textStream, {
      prefix: `      [fix:${spec.name}] `,
      echo: false,
    });
    currentArtifacts = parseArtifacts(fixedText, currentArtifacts);
  }

  return {
    componentName: spec.name,
    entryFileName: generator.getEntryArtifact(currentArtifacts).fileName,
    artifacts: currentArtifacts,
    generatorId: generator.id,
    selfReviewResult: reviewResult,
    modelTiersUsed: tiersUsed,
  };
}

export async function runCodeProducer(
  specs: ComponentSpec[],
  providers: AllProviders,
  options: {
    framework?: string;
    styleMethod?: string;
    darkMode?: boolean;
    concurrency?: number;
  } = {},
): Promise<CodeProducerResult> {
  const {
    framework = 'react',
    styleMethod = 'tailwind',
    darkMode = false,
    concurrency = 3,
  } = options;

  console.log(`\n🔧 [Code Agent] 开始生成 ${specs.length} 个组件...`);

  let components: CodeOutput[];

  if (specs.length <= concurrency) {
    console.log(`   ⚡ 并行生成 ${specs.length} 个组件...`);
    components = await Promise.all(
      specs.map((spec) =>
        generateSingleComponent(spec, providers, { framework, styleMethod, darkMode }),
      ),
    );
  } else {
    components = [];
    for (let i = 0; i < specs.length; i += concurrency) {
      const batch = specs.slice(i, i + concurrency);
      console.log(`   ⚡ 并行生成第 ${i + 1}-${Math.min(i + concurrency, specs.length)} 个组件...`);
      const batchResults = await Promise.all(
        batch.map((spec) =>
          generateSingleComponent(spec, providers, { framework, styleMethod, darkMode }),
        ),
      );
      components.push(...batchResults);
    }
  }

  for (const comp of components) {
    const tiers = [...new Set(comp.modelTiersUsed)].join(', ');
    const files = comp.artifacts.map((artifact) => artifact.fileName).join(', ');
    console.log(
      `   ✅ ${comp.componentName} 完成 (${comp.generatorId} | ${files} | used: ${tiers})`,
    );
  }

  const allPassed = components.every((component) => component.selfReviewResult.passed);
  console.log(
    `\n🔧 [Code Agent] 完成！${components.length} 个组件，全部通过自检：${allPassed ? '✅' : '❌'}\n`,
  );

  return {
    components,
    totalComponents: components.length,
    allPassed,
  };
}
