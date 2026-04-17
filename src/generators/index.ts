/**
 * @file generators/index.ts — 代码生成器注册表与查找入口
 *
 * 本文件管理所有已注册的代码生成器实例，并提供按框架名称查找的能力。
 *
 * 架构角色：
 *   - 作为生成器子系统的"服务发现"层
 *   - 上层（如流水线控制器）只需调用 getCodeGenerator('react')
 *     即可获取对应的生成器实例，无需关心具体实现
 *   - 支持框架名称的模糊归一化（如 'vanilla' → 'html+css+js'）
 *
 * 注册的生成器：
 *   1. reactGenerator    — React/TSX 组件生成
 *   2. vanillaGenerator  — 原生 HTML/CSS/JS 生成
 *   3. vueGenerator      — Vue 3 SFC 生成
 *   4. svelteGenerator   — Svelte 组件生成
 *
 * @module generators/index
 */

import { reactGenerator } from './react-generator.js'; // React/TSX 生成器
import { vueGenerator } from './vue-generator.js'; // Vue SFC 生成器
import { svelteGenerator } from './svelte-generator.js'; // Svelte 生成器
import { vanillaGenerator } from './vanilla-generator.js'; // 原生 HTML/CSS/JS 生成器
import type { CodeGenerator } from './types.js'; // 生成器接口类型

// ── 生成器注册列表 ──────────────────────────────────────
// 所有可用的代码生成器实例（顺序决定遍历优先级，React 排第一作为默认回退）

/** 全部已注册的生成器实例 */
const generators: CodeGenerator[] = [
  reactGenerator,
  vanillaGenerator,
  vueGenerator,
  svelteGenerator,
];

// ── 框架名称归一化 ──────────────────────────────────────

/**
 * 将用户输入的框架名称归一化为标准标识符
 *
 * 处理常见的变体和别名：
 *   - 'html+css+js', 'vanilla', 'native', 'javascript', 'html' → 'html+css+js'
 *   - 其他值保持原样（由生成器的 frameworkAliases 进一步匹配）
 *
 * @param framework - 用户输入的框架名称
 * @returns 归一化后的标准标识符
 */
function normalizeFramework(framework: string): string {
  const value = framework.trim().toLowerCase();
  // 检测包含 html+css+js 组合关键词的输入
  if (value.includes('html') && value.includes('css') && value.includes('js')) {
    return 'html+css+js';
  }
  // 将常见别名统一映射到 'html+css+js'
  if (['vanilla', 'native', 'javascript', 'js', 'html'].includes(value)) {
    return 'html+css+js';
  }
  return value;
}

// ── 对外 API ────────────────────────────────────────────

/**
 * 获取所有已注册的代码生成器列表
 *
 * @returns 生成器实例数组
 */
export function listCodeGenerators(): CodeGenerator[] {
  return generators;
}

/**
 * 根据框架名称查找对应的代码生成器
 *
 * 查找流程：
 *   1. 将框架名称归一化（normalizeFramework）
 *   2. 在生成器列表中查找 frameworkAliases 包含该名称的生成器
 *   3. 未找到时安全回退到 React 生成器（最通用的默认选择）
 *
 * @param framework - 目标框架名称（支持各种别名和变体）
 * @returns 匹配的代码生成器实例（保证非 null）
 *
 * @example
 * ```ts
 * getCodeGenerator('react')     // → reactGenerator
 * getCodeGenerator('vanilla')   // → vanillaGenerator
 * getCodeGenerator('vue3')      // → vueGenerator
 * getCodeGenerator('unknown')   // → reactGenerator（默认回退）
 * ```
 */
export function getCodeGenerator(framework: string): CodeGenerator {
  const normalized = normalizeFramework(framework);
  // 在注册列表中查找别名匹配，未找到则回退到 React 生成器
  return (
    generators.find((generator) => generator.frameworkAliases.includes(normalized)) ??
    reactGenerator
  );
}
