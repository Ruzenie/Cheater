import type { RefinedRequirement } from '../agents/prompt-refiner.js';
import { getCodeGenerator } from './index.js';

export interface FrameworkRoutingInput {
  requirement: string;
  refinedRequirement?: RefinedRequirement;
  explicitFramework?: string;
}

export interface FrameworkRoutingResult {
  framework: string;
  source: 'user-input' | 'refined-stack' | 'explicit' | 'default';
  reason: string;
  overriddenExplicit: boolean;
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function inferFrameworkFromText(text: string): {
  framework?: string;
  reason?: string;
} {
  const normalized = text.toLowerCase();

  const vuePatterns = [/\bvue\b/, /vue3/, /<template>/, /<script\s+setup>/, /composition\s*api/];
  const sveltePatterns = [/\bsvelte\b/, /sveltekit/, /\$:/, /on:click/];

  const vanillaPatterns = [
    /\bhtml\b/,
    /\bcss\b/,
    /\bjavascript\b/,
    /\bjs\b/,
    /html\+css\+js/,
    /原生/,
    /不要\s*react/,
    /不用\s*react/,
    /非\s*react/,
  ];
  const reactPatterns = [/\breact\b/, /\bjsx\b/, /\btsx\b/, /\bhooks?\b/, /usestate/, /useeffect/];

  const vueScore = countMatches(normalized, vuePatterns);
  const svelteScore = countMatches(normalized, sveltePatterns);
  const vanillaScore = countMatches(normalized, vanillaPatterns);
  const reactScore = countMatches(normalized, reactPatterns);

  const strongestScore = Math.max(vueScore, svelteScore, vanillaScore, reactScore);
  if (strongestScore === 0) {
    return {};
  }

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

function normalizeSuggestedFramework(framework?: string): string | undefined {
  if (!framework) return undefined;
  const normalized = framework.trim().toLowerCase();

  if (normalized.includes('html') && normalized.includes('css') && normalized.includes('js')) {
    return 'html+css+js';
  }
  if (['html', 'javascript', 'js', 'vanilla', 'native'].includes(normalized)) {
    return 'html+css+js';
  }
  if (normalized.includes('react')) {
    return 'react';
  }
  if (normalized.includes('vue')) {
    return 'vue';
  }
  if (normalized.includes('svelte')) {
    return 'svelte';
  }

  return undefined;
}

export function resolveFrameworkFromUserInput(
  input: FrameworkRoutingInput,
): FrameworkRoutingResult {
  const explicitFramework = input.explicitFramework?.trim();

  const directInference = inferFrameworkFromText(input.requirement);
  if (directInference.framework) {
    return {
      framework: directInference.framework,
      source: 'user-input',
      reason: directInference.reason ?? '根据用户原始输入推断',
      overriddenExplicit: Boolean(
        explicitFramework &&
        getCodeGenerator(explicitFramework).id !== getCodeGenerator(directInference.framework).id,
      ),
    };
  }

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

  if (explicitFramework) {
    return {
      framework: explicitFramework,
      source: 'explicit',
      reason: '未检测到更强的用户输入信号，沿用显式 framework 参数',
      overriddenExplicit: false,
    };
  }

  return {
    framework: 'react',
    source: 'default',
    reason: '未提供明确框架信号，回退到默认 generator',
    overriddenExplicit: false,
  };
}
