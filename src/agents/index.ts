/**
 * agents/index.ts — Barrel 导出文件
 *
 * 统一导出所有 Agent 模块的公开接口。
 * 外部调用方只需 `import { runOrchestrator, ... } from './agents'` 即可。
 *
 * 各 Agent 在流水线中的执行顺序：
 *   1. runPromptRefiner    → 需求精炼（Step 0）
 *   2. runDesignAnalyzer   → 设计分析（Step 2）
 *   3. runProjectPlanner   → 项目规划（Step 3）
 *   4. runCodeProducer     → 代码生成（Step 4）
 *   5. runCodeAuditor      → 代码审计（Step 5/7）
 *   6. runCodeAssembler    → 代码组装（Step 6）
 *   7. runOrchestrator     → 总调度器（串联以上所有步骤）
 *
 * 已废弃：
 *   - page-assembler（initializePageAssembly/assemblePageIncrementally/appendComponentToAssembly）
 *     已被 code-assembler + project-planner 取代，保留仅为向后兼容
 */

// ── 需求精炼 Agent ──
export { runPromptRefiner, type RefinedRequirement } from './prompt-refiner.js';
// ── 设计分析 Agent ──
export { runDesignAnalyzer, type DesignOutput } from './design-analyzer.js';
// ── 项目规划 Agent ──
export {
  runProjectPlanner,
  type ProjectStructure,
  type ProjectPlannerResult,
  type ProjectFileEntry,
  type ComponentMapping,
} from './project-planner.js';
// ── 代码生成 Agent ──
export { runCodeProducer, type CodeOutput, type CodeProducerResult } from './code-producer.js';
// ── 旧版页面组装 Agent（已废弃） ──
export {
  initializePageAssembly,
  assemblePageIncrementally,
  appendComponentToAssembly,
  type AssembledPageResult,
} from './page-assembler.js';
// ── 代码审计 Agent ──
export { runCodeAuditor, type AuditOutput } from './code-auditor.js';
// ── 代码组装 Agent ──
export { runCodeAssembler, type AssemblyResult, type AssembledFile } from './code-assembler.js';
// ── 总调度器 ──
export { runOrchestrator, type OrchestratorResult } from './orchestrator.js';
