/**
 * code-producer.ts — 代码制作 Agent（v3 — 可插拔生成器架构）
 *
 * 本文件负责将设计分析产出的 ComponentSpec 数组转化为实际代码文件。
 * 每个组件经历 scaffold → fill → style → self-review → fix 五阶段流水线。
 *
 * 在流水线中的位置：
 *   Step 4: orchestrator 在设计分析（Step 2）完成后调用本模块
 *   与 project-planner（Step 3）并行执行（fork-join 模式）
 *   输出传递给 code-auditor（Step 5）进行质量审计
 *
 * 可插拔生成器架构：
 *   通过 `getCodeGenerator(framework)` 获取对应框架的生成器（React/Vue/Svelte/Vanilla），
 *   生成器提供 scaffold、fill、style、fix 各阶段的 prompt 和文件结构，
 *   本模块负责调用 LLM 执行各阶段并管理结果。
 *
 * 模型策略（逐级升级）：
 *   - scaffold（骨架）→ executor（纯模板，零 LLM）
 *   - fill（填充逻辑）→ worker（需要理解需求和框架约定）
 *   - style（样式增强）→ executor（简单的 CSS/样式处理）
 *   - self-review（自检）→ 零 LLM（纯规则检查）
 *   - fix（修复问题）→ reasoner（需要深入理解问题并修复）
 *
 * 并行策略：
 *   - 组件数 ≤ concurrency 时，所有组件全并行（Promise.all）
 *   - 组件数 > concurrency 时，按批次并行（防止 OOM）
 *   - 每个组件注入 siblingSpecs 上下文，让组件知道兄弟组件的存在，避免功能重叠
 *
 * 输入类型：
 *   @param specs - ComponentSpec[]（来自 design-analyzer 的组件树）
 *
 * 输出类型：
 *   @returns CodeProducerResult - 包含所有组件的代码文件、自检结果、使用的模型层级
 */

import { streamText } from 'ai';
import { getWrappedModel, type AllProviders, type ModelTier } from '../config/index.js';
import { getCodeGenerator } from '../generators/index.js';
import type { GeneratedArtifact } from '../generators/types.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import type { ComponentSpec } from '../tools/design/index.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';

// ── 输出类型 ──────────────────────────────────────────

/**
 * 单个组件的代码生成结果。
 * 包含组件名、入口文件、所有产出文件（artifacts）、使用的生成器和模型层级。
 */
export interface CodeOutput {
  /** 组件名（PascalCase） */
  componentName: string;
  /** 入口文件名（如 LoginForm.tsx） */
  entryFileName: string;
  /** 所有产出文件（组件代码、样式、类型定义等） */
  artifacts: GeneratedArtifact[];
  /** 使用的生成器 ID（react/vue/svelte/html+css+js） */
  generatorId: string;
  /** 自检结果（是否通过、发现的问题列表） */
  selfReviewResult: {
    passed: boolean;
    issues: Array<{ check: string; severity: string; message: string }>;
  };
  /** 实际使用的模型层级列表（按调用顺序） */
  modelTiersUsed: ModelTier[];
}

/**
 * 所有组件的代码生成汇总结果。
 */
export interface CodeProducerResult {
  /** 各组件的代码产出 */
  components: CodeOutput[];
  /** 组件总数 */
  totalComponents: number;
  /** 是否所有组件都通过了自检 */
  allPassed: boolean;
}

// ── Telemetry 配置 ──────────────────────────────────

/**
 * 构建 telemetry 配置对象。
 *
 * @param functionId - 调用标识符，格式为 `code-producer:<阶段>:<生成器>:<组件名>`
 * @returns AI SDK 的 experimental_telemetry 配置
 */
function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 工具函数 ──────────────────────────────────────────

/**
 * 将 artifacts 数组拼接为纯文本，用于自检和 prompt 构建。
 * 每个文件以 `// FILE: <文件名>` 为分隔头。
 *
 * @param artifacts - 产出文件数组
 * @returns 拼接后的纯文本
 */
function artifactsToText(artifacts: GeneratedArtifact[]): string {
  return artifacts
    .map((artifact) => `// FILE: ${artifact.fileName}\n${artifact.content}`)
    .join('\n\n');
}

/**
 * 构建要求 LLM 按指定文件名输出 JSON 的规则文本。
 * 嵌入到 system prompt 中，确保 LLM 输出的 JSON 与预期的文件列表一致。
 *
 * @param artifacts - 预期的文件列表（提供文件名约束）
 * @returns 规则描述文本
 */
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

/**
 * 将 LLM 返回的原始 JSON 标准化为 GeneratedArtifact 数组。
 * 兼容两种格式：
 *   1. `{ files: [{fileName, content}] }` — 标准格式
 *   2. `{ "filename": "content" }` — 对象 key-value 格式（某些模型的非标输出）
 * 如果解析出的内容为空，回退到 fallbackArtifacts（骨架代码）。
 *
 * @param raw               - LLM 返回的原始解析对象
 * @param fallbackArtifacts - 骨架代码（解析失败时的兜底）
 * @returns 标准化后的 GeneratedArtifact 数组
 */
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

/**
 * 解析 LLM 的文本输出为 GeneratedArtifact 数组。
 * 先尝试 JSON 解析 + 标准化，失败时回退到骨架代码并输出警告。
 * 常见失败原因：maxOutputTokens 不足导致 JSON 被截断。
 *
 * @param text              - LLM 的原始文本输出
 * @param fallbackArtifacts - 骨架代码（解析失败时的兜底）
 * @returns 解析后的 GeneratedArtifact 数组
 */
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

// ── 自检逻辑 ──────────────────────────────────────────

/**
 * 对生成的代码进行零 LLM 成本的规则自检。
 * 根据不同框架检查对应的常见问题：
 *   - React: Props 类型定义、any 类型
 *   - Vue: .vue 文件存在性、混入非 Vue 语法（如 useState/className）
 *   - Svelte: .svelte 文件存在性、混入非 Svelte 语法（如 defineProps/<template>）
 *   - Vanilla: 混入 React/JSX 痕迹、HTML 文件存在性
 *   - 通用: fetch 错误处理、async try-catch、单字母变量名、文件过长
 *
 * @param artifacts   - 待检查的代码文件数组
 * @param generatorId - 生成器 ID（决定检查哪些框架特定规则）
 * @returns 检查结果，包含是否通过和问题列表
 */
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

  // ── 框架特定的语法交叉污染检测 ──
  // 检测 Vue 代码中是否混入了其他框架的语法痕迹
  // 正则匹配 React（import React/useState/className）、Svelte（on:click/export let）等特征
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

  // 检测 Svelte 代码中是否混入了 React（import React）、Vue（defineProps/<template>/<script setup）等特征
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

  // 检测 Vanilla 代码中是否混入了 React/JSX 痕迹（import React、React.、useState、className、大写开头标签）
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

  // ── 通用代码质量检查 ──

  // 检测 fetch 调用是否缺少 catch 错误处理
  if (combined.includes('fetch(') && !combined.includes('catch')) {
    issues.push({
      check: 'error-handling',
      severity: 'critical',
      message: 'fetch 调用缺少错误处理',
    });
  }
  // 检测 async 函数是否缺少 try-catch 保护
  if (combined.includes('async') && !combined.includes('try')) {
    issues.push({
      check: 'error-handling',
      severity: 'warning',
      message: '异步操作缺少 try-catch',
    });
  }

  // 正则检测单字母变量声明（如 const x = ...），通常是代码质量差的信号
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

// ── 单组件生成流水线 ──────────────────────────────────

/**
 * 生成单个组件的完整代码，经历 scaffold → fill → style → self-review → fix 五阶段。
 *
 * 各阶段说明：
 *   1. scaffold：通过生成器模板创建骨架文件（零 LLM）
 *   2. fill：worker 模型填充业务逻辑和组件实现
 *   3. style：executor 模型增强样式（可选，由生成器决定是否支持）
 *   4. self-review：规则自检，发现框架语法错误和代码质量问题
 *   5. fix：仅当自检不通过时，升级到 reasoner 模型修复问题
 *
 * 容错策略：如果 LLM 调用失败（网络超时、流终止），回退到骨架代码而非崩溃，
 * 确保 Promise.all 中其他组件不受影响。
 *
 * @param spec         - 单个组件的规格（名称、描述、props、states 等）
 * @param providers    - LLM 提供商配置
 * @param options      - 框架、样式、暗色模式配置
 * @param siblingSpecs - 兄弟组件的规格列表（注入上下文避免功能重叠）
 * @returns 单个组件的代码生成结果
 */
async function generateSingleComponent(
  spec: ComponentSpec,
  providers: AllProviders,
  options: { framework: string; styleMethod: string; darkMode: boolean },
  siblingSpecs: ComponentSpec[] = [],
): Promise<CodeOutput> {
  const generator = getCodeGenerator(options.framework);
  const tiersUsed: ModelTier[] = [];

  console.log(`      🧩 ${spec.name} 使用生成器: ${generator.displayName}`);

  tiersUsed.push('executor');
  let currentArtifacts = generator.createScaffold(spec, options);

  try {
    tiersUsed.push('worker');

    // 构建兄弟组件上下文，让当前组件知道其他组件的存在
    let siblingContext = '';
    if (siblingSpecs.length > 0) {
      const siblingList = siblingSpecs.map((s) => `  - ${s.name}：${s.description}`).join('\n');
      siblingContext = `\n\n⚠ 组件协调上下文：
以下是和你同时被生成的兄弟组件，它们各自负责页面的不同部分：
${siblingList}

你只需要负责实现 ${spec.name} 的功能（${spec.description}）。
不要实现其他兄弟组件已经负责的功能。不要输出页面级的布局结构（header、footer、整体页面框架）——那些由组装器负责。`;
    }

    const fillStream = streamText({
      model: getWrappedModel('worker', providers),
      system: `${generator.buildFillSystem(options)}\n\n${buildArtifactsJsonRule(currentArtifacts)}`,
      prompt: `${generator.buildFillPrompt(spec, currentArtifacts, options)}${siblingContext}`,
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
  } catch (error: unknown) {
    // 流被 LLM 提供商终止（terminated）、网络超时等情况下，
    // 回退到骨架代码而不是让整个 Promise.all 崩溃
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`      ❌ ${spec.name} 生成失败 (${message})，回退到骨架代码`);

    const fallbackReview = runSelfReview(currentArtifacts, generator.id);
    return {
      componentName: spec.name,
      entryFileName: generator.getEntryArtifact(currentArtifacts).fileName,
      artifacts: currentArtifacts,
      generatorId: generator.id,
      selfReviewResult: fallbackReview,
      modelTiersUsed: tiersUsed,
    };
  }
}

// ── Agent 主函数 ──────────────────────────────────────

/**
 * 代码制作 Agent 主函数 — 将 ComponentSpec 数组转化为实际代码。
 *
 * 并行策略：
 *   - 组件数 ≤ concurrency：所有组件同时并行生成
 *   - 组件数 > concurrency：按 concurrency 为批次分组并行，防止并发过多导致 OOM
 *   - 每个组件注入 siblingSpecs（排除自身），让 LLM 知道其他组件负责什么，避免功能重叠
 *
 * @param specs     - 组件规格数组（来自 design-analyzer 的组件树）
 * @param providers - LLM 提供商配置
 * @param options   - 框架、样式、暗色模式、并行度配置
 * @returns 所有组件的代码生成汇总结果
 */
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
      specs.map((spec) => {
        const siblings = specs.filter((s) => s.name !== spec.name);
        return generateSingleComponent(
          spec,
          providers,
          { framework, styleMethod, darkMode },
          siblings,
        );
      }),
    );
  } else {
    components = [];
    for (let i = 0; i < specs.length; i += concurrency) {
      const batch = specs.slice(i, i + concurrency);
      console.log(`   ⚡ 并行生成第 ${i + 1}-${Math.min(i + concurrency, specs.length)} 个组件...`);
      const batchResults = await Promise.all(
        batch.map((spec) => {
          const siblings = specs.filter((s) => s.name !== spec.name);
          return generateSingleComponent(
            spec,
            providers,
            { framework, styleMethod, darkMode },
            siblings,
          );
        }),
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
