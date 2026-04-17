/**
 * @file generators/types.ts — 代码生成器类型定义
 *
 * 本文件定义了 Cheater 代码生成子系统的核心类型契约。
 * 所有框架特定的生成器（React、Vue、Svelte、Vanilla）都必须实现
 * CodeGenerator 接口，确保统一的生成流水线行为。
 *
 * 架构角色：
 *   - 作为生成器子系统的"类型基石"，被所有具体生成器依赖
 *   - 定义了从骨架搭建 → 代码填充 → 样式优化 → 问题修复的完整生命周期方法
 *   - GeneratedArtifact 是生成产物的统一数据结构，贯穿整个流水线
 *
 * 生成流水线概览：
 *   createScaffold() → buildFill*() → buildStyle*() → buildFix*() → getEntryArtifact()
 *
 * @module generators/types
 */

import type { ComponentSpec } from '../tools/design/index.js'; // 组件规格描述（由设计分析工具产出）

// ══════════════════════════════════════════════════════
//  生成产物类型
// ══════════════════════════════════════════════════════

/**
 * 生成器产出的单个文件（代码产物）
 *
 * 每次代码生成可能产出多个文件（如 Vanilla 模式下有 .html + .css + .js），
 * 每个文件用一个 GeneratedArtifact 表示。
 */
export interface GeneratedArtifact {
  /** 文件名（如 'LoginForm.tsx', 'LoginForm.css'） */
  fileName: string;
  /** 文件内容（完整的源代码字符串） */
  content: string;
  /**
   * 文件角色
   * - 'component' — 组件文件（React TSX / Vue SFC / Svelte 组件）
   * - 'markup'    — HTML 标记文件（仅 Vanilla 模式）
   * - 'style'     — 样式文件（CSS / SCSS）
   * - 'script'    — 脚本文件（仅 Vanilla 模式的 JS 文件）
   */
  role: 'component' | 'markup' | 'style' | 'script';
}

// ══════════════════════════════════════════════════════
//  生成器选项
// ══════════════════════════════════════════════════════

/**
 * 代码生成器的运行时选项
 *
 * 控制生成器在特定上下文中的行为（框架选择、样式方案、暗色模式等）。
 */
export interface CodeGeneratorOptions {
  /** 目标框架标识（如 'react', 'vue', 'html+css+js'） */
  framework: string;
  /** 样式方案（如 'css', 'css-modules', 'tailwind', 'styled-component'） */
  styleMethod: string;
  /** 是否需要支持暗色模式 */
  darkMode: boolean;
}

// ══════════════════════════════════════════════════════
//  代码生成器接口（核心契约）
// ══════════════════════════════════════════════════════

/**
 * 代码生成器接口 — 所有框架生成器必须实现的契约
 *
 * 定义了完整的代码生成生命周期方法，对应流水线的各个阶段：
 *
 * 1. **骨架阶段** — createScaffold()：生成带 TODO 占位符的初始文件结构
 * 2. **填充阶段** — buildFillSystem() + buildFillPrompt()：构造让 LLM 补全代码的 prompt
 * 3. **样式阶段** — supportsStylePass() + buildStyleSystem() + buildStylePrompt()：可选的样式优化
 * 4. **修复阶段** — buildFixPrompt()：根据质检问题构造修复 prompt
 * 5. **入口定位** — getEntryArtifact()：确定哪个文件是组件的入口文件
 */
export interface CodeGenerator {
  /** 生成器唯一标识（如 'react', 'vue', 'svelte', 'html+css+js'） */
  id: string;
  /** 人类可读名称（用于日志和 UI 展示） */
  displayName: string;
  /** 框架别名列表（用于匹配用户输入，如 ['react', 'react+ts', 'tsx']） */
  frameworkAliases: string[];

  /**
   * 骨架阶段：根据组件规格生成带 TODO 的初始文件结构
   *
   * @param spec    - 组件规格（名称、props、states、events 等）
   * @param options - 生成器运行时选项
   * @returns 骨架文件数组（包含 TODO 占位符）
   */
  createScaffold(spec: ComponentSpec, options: CodeGeneratorOptions): GeneratedArtifact[];

  /**
   * 填充阶段：构造系统 prompt（角色设定 + 输出规则）
   *
   * @param options - 生成器运行时选项
   * @returns 系统级 prompt 字符串
   */
  buildFillSystem(options: CodeGeneratorOptions): string;

  /**
   * 填充阶段：构造用户 prompt（骨架 + 需求 → 完整代码）
   *
   * @param spec      - 组件规格
   * @param artifacts - 当前骨架文件
   * @param options   - 生成器运行时选项
   * @returns 用户级 prompt 字符串
   */
  buildFillPrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    options: CodeGeneratorOptions,
  ): string;

  /**
   * 样式阶段：判断当前配置是否支持独立的样式优化 pass
   *
   * 例如 Tailwind 需要专门的类名补充 pass，而 Vue scoped 不需要。
   *
   * @param options - 生成器运行时选项
   * @returns 是否支持样式优化 pass
   */
  supportsStylePass(options: CodeGeneratorOptions): boolean;

  /**
   * 样式阶段：构造样式优化的系统 prompt
   *
   * @param options - 生成器运行时选项
   * @returns 系统级 prompt 字符串
   */
  buildStyleSystem(options: CodeGeneratorOptions): string;

  /**
   * 样式阶段：构造样式优化的用户 prompt
   *
   * @param spec      - 组件规格
   * @param artifacts - 当前代码文件
   * @param options   - 生成器运行时选项
   * @returns 用户级 prompt 字符串
   */
  buildStylePrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    options: CodeGeneratorOptions,
  ): string;

  /**
   * 修复阶段：根据质检发现的问题构造修复 prompt
   *
   * @param spec      - 组件规格
   * @param artifacts - 当前代码文件
   * @param issues    - 质检发现的问题列表
   * @param options   - 生成器运行时选项
   * @returns 修复指令 prompt 字符串
   */
  buildFixPrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
    options: CodeGeneratorOptions,
  ): string;

  /**
   * 入口定位：从产物数组中找到组件的入口文件
   *
   * React/Vue/Svelte 通常是第一个文件，Vanilla 模式下优先选择 .html 文件。
   *
   * @param artifacts - 代码产物数组
   * @returns 入口文件产物
   * @throws 产物数组为空时抛出错误
   */
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact;
}
