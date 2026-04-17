/**
 * @file generators/router.ts — 框架检测与路由逻辑
 *
 * 本文件负责从用户输入中自动推断应使用的前端框架，
 * 确保生成器选择与用户意图最大化一致。
 *
 * 架构角色：
 *   - 位于生成器选择的上游，在调用 getCodeGenerator() 之前先确定框架
 *   - 综合多种信号源（用户原始输入、精炼需求、显式参数）进行决策
 *   - 支持信号冲突时的优先级仲裁（用户输入 > 精炼推断 > 显式参数 > 默认值）
 *
 * 信号优先级（从高到低）：
 *   1. user-input    — 用户原始需求文本中的框架信号（最强信号）
 *   2. refined-stack — Prompt Refiner 在精炼需求中建议的技术栈
 *   3. explicit      — 调用者显式传入的 framework 参数
 *   4. default       — 所有信号都缺失时回退到 React
 *
 * @module generators/router
 */

import type { RefinedRequirement } from '../agents/prompt-refiner.js'; // 精炼后的需求结构
import { getCodeGenerator } from './index.js'; // 生成器查找（用于判断框架是否有效）

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/**
 * 框架路由的输入参数
 */
export interface FrameworkRoutingInput {
  /** 用户的原始需求文本 */
  requirement: string;
  /** Prompt Refiner 精炼后的需求（可选） */
  refinedRequirement?: RefinedRequirement;
  /** 调用者显式指定的框架（可选） */
  explicitFramework?: string;
}

/**
 * 框架路由的决策结果
 */
export interface FrameworkRoutingResult {
  /** 最终选定的框架标识（如 'react', 'vue', 'html+css+js'） */
  framework: string;
  /** 决策信号来源 */
  source: 'user-input' | 'refined-stack' | 'explicit' | 'default';
  /** 人类可读的决策理由 */
  reason: string;
  /** 是否覆盖了显式传入的 framework 参数（用于提醒用户注意冲突） */
  overriddenExplicit: boolean;
}

// ══════════════════════════════════════════════════════
//  内部辅助函数
// ══════════════════════════════════════════════════════

/**
 * 统计文本中匹配正则模式的数量
 *
 * @param text     - 待匹配的文本
 * @param patterns - 正则模式数组
 * @returns 命中的模式数量（每个模式最多计 1 分）
 */
function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

/**
 * 从文本中推断框架类型（基于正则模式匹配）
 *
 * 分别用四组正则模式匹配 Vue / Svelte / Vanilla / React 的特征信号，
 * 取得分最高的框架作为推断结果。
 *
 * 匹配优先级（得分相同时）：
 *   Vue > Svelte > Vanilla ≥ React
 *   （Vanilla 和 React 得分相同时优先 Vanilla，因为用户可能明确不想用 React）
 *
 * @param text - 待分析的文本
 * @returns 推断出的框架和推理理由，无信号时返回空对象
 */
function inferFrameworkFromText(text: string): {
  framework?: string;
  reason?: string;
} {
  const normalized = text.toLowerCase();

  // 各框架的特征正则模式
  const vuePatterns = [/\bvue\b/, /vue3/, /<template>/, /<script\s+setup>/, /composition\s*api/];
  const sveltePatterns = [/\bsvelte\b/, /sveltekit/, /\$:/, /on:click/];

  const vanillaPatterns = [
    /\bhtml\b/,
    /\bcss\b/,
    /\bjavascript\b/,
    /\bjs\b/,
    /html\+css\+js/,
    /原生/,
    /不要\s*react/, // "不要 React" 是强烈的原生信号
    /不用\s*react/,
    /非\s*react/,
  ];
  const reactPatterns = [/\breact\b/, /\bjsx\b/, /\btsx\b/, /\bhooks?\b/, /usestate/, /useeffect/];

  // 计算各框架的匹配得分
  const vueScore = countMatches(normalized, vuePatterns);
  const svelteScore = countMatches(normalized, sveltePatterns);
  const vanillaScore = countMatches(normalized, vanillaPatterns);
  const reactScore = countMatches(normalized, reactPatterns);

  // 取最高得分，无信号时直接返回
  const strongestScore = Math.max(vueScore, svelteScore, vanillaScore, reactScore);
  if (strongestScore === 0) {
    return {}; // 未检测到任何框架信号
  }

  // 按优先级判定：Vue > Svelte > Vanilla ≥ React
  if (vueScore === strongestScore) {
    return {
      framework: 'vue',
      reason: `检测到 Vue 信号 (${vueScore} 命中)`,
    };
  }

  if (svelteScore === strongestScore) {
    return {
      framework: 'svelte',
      reason: `检测到 Svelte 信号 (${svelteScore} 命中)`,
    };
  }

  // Vanilla 和 React 得分相同时优先 Vanilla
  // 因为 "不要 react" 等排斥性表达也会匹配 vanillaPatterns
  if (vanillaScore >= reactScore) {
    return {
      framework: 'html+css+js',
      reason: `检测到原生前端信号 (${vanillaScore} > ${reactScore})`,
    };
  }

  return {
    framework: 'react',
    reason: `检测到 React 信号 (${reactScore} > ${vanillaScore})`,
  };
}

/**
 * 将 Prompt Refiner 建议的框架名称归一化为标准标识符
 *
 * @param framework - 原始框架建议（可能为 undefined）
 * @returns 归一化后的标识符，无法识别时返回 undefined
 */
function normalizeSuggestedFramework(framework?: string): string | undefined {
  if (!framework) return undefined;
  const normalized = framework.trim().toLowerCase();

  // 检测 html+css+js 组合
  if (normalized.includes('html') && normalized.includes('css') && normalized.includes('js')) {
    return 'html+css+js';
  }
  // 常见原生开发别名
  if (['html', 'javascript', 'js', 'vanilla', 'native'].includes(normalized)) {
    return 'html+css+js';
  }
  // 框架名称匹配
  if (normalized.includes('react')) {
    return 'react';
  }
  if (normalized.includes('vue')) {
    return 'vue';
  }
  if (normalized.includes('svelte')) {
    return 'svelte';
  }

  return undefined; // 无法识别的框架名
}

// ══════════════════════════════════════════════════════
//  对外 API — 框架路由主函数
// ══════════════════════════════════════════════════════

/**
 * 从用户输入中解析并确定最终使用的前端框架
 *
 * 按优先级逐级尝试多种信号源：
 *   1. 用户原始需求文本中的框架信号（最强 — 用户明确说了什么框架）
 *   2. 精炼需求文本中的框架信号（次强 — Prompt Refiner 分析后的信号）
 *   3. Prompt Refiner 建议的技术栈框架（中等）
 *   4. 调用者显式传入的 framework 参数（较弱 — 可被用户输入覆盖）
 *   5. 默认回退到 React（最弱 — 所有信号都缺失）
 *
 * 当更强信号与显式参数冲突时，overriddenExplicit 会设为 true，
 * 提醒上层注意此冲突（例如用户说"用 Vue"但参数传了 React）。
 *
 * @param input - 路由输入（用户需求 + 可选的精炼需求和显式框架）
 * @returns 路由决策结果，包含框架、信号来源、理由和冲突标记
 *
 * @example
 * ```ts
 * // 用户明确提到 Vue
 * resolveFrameworkFromUserInput({ requirement: '用 Vue 3 写一个表单' });
 * // → { framework: 'vue', source: 'user-input', reason: '...', overriddenExplicit: false }
 *
 * // 用户说"不要 React"，但显式参数是 React → 覆盖
 * resolveFrameworkFromUserInput({ requirement: '不要 React', explicitFramework: 'react' });
 * // → { framework: 'html+css+js', source: 'user-input', overriddenExplicit: true, ... }
 * ```
 */
export function resolveFrameworkFromUserInput(
  input: FrameworkRoutingInput,
): FrameworkRoutingResult {
  const explicitFramework = input.explicitFramework?.trim();

  // ── 信号 1: 用户原始需求文本中的直接推断 ──
  const directInference = inferFrameworkFromText(input.requirement);
  if (directInference.framework) {
    return {
      framework: directInference.framework,
      source: 'user-input',
      reason: directInference.reason ?? '根据用户原始输入推断',
      // 检测是否与显式参数冲突（比较生成器 ID 而非原始字符串）
      overriddenExplicit: Boolean(
        explicitFramework &&
        getCodeGenerator(explicitFramework).id !== getCodeGenerator(directInference.framework).id,
      ),
    };
  }

  // ── 信号 2: 精炼需求文本中的推断 ──
  const refinedText = input.refinedRequirement?.refined;
  if (refinedText) {
    const refinedInference = inferFrameworkFromText(refinedText);
    if (refinedInference.framework) {
      return {
        framework: refinedInference.framework,
        source: 'user-input',
        reason: `根据精炼需求推断：${refinedInference.reason ?? '命中文本特征'}`,
        overriddenExplicit: Boolean(
          explicitFramework &&
          getCodeGenerator(explicitFramework).id !==
            getCodeGenerator(refinedInference.framework).id,
        ),
      };
    }
  }

  // ── 信号 3: Prompt Refiner 建议的技术栈 ──
  const suggestedFramework = normalizeSuggestedFramework(
    input.refinedRequirement?.suggestedStack?.framework,
  );
  if (suggestedFramework) {
    return {
      framework: suggestedFramework,
      source: 'refined-stack',
      reason: `Prompt Refiner 建议使用 ${suggestedFramework}`,
      overriddenExplicit: Boolean(
        explicitFramework &&
        getCodeGenerator(explicitFramework).id !== getCodeGenerator(suggestedFramework).id,
      ),
    };
  }

  // ── 信号 4: 调用者显式指定的框架 ──
  if (explicitFramework) {
    return {
      framework: explicitFramework,
      source: 'explicit',
      reason: '未检测到更强的用户输入信号，沿用显式 framework 参数',
      overriddenExplicit: false,
    };
  }

  // ── 信号 5: 默认回退 ──
  return {
    framework: 'react',
    source: 'default',
    reason: '未提供明确框架信号，回退到默认 generator',
    overriddenExplicit: false,
  };
}
