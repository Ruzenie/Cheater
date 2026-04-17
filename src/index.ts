/**
 * @file index.ts — Cheater 多模型前端代码生成系统的主入口（Barrel 导出文件）
 *
 * 本文件是整个 Cheater 系统的公共 API 出口。
 * 外部使用者只需 import from 'cheater' 即可访问所有功能模块。
 *
 * 导出的模块分类：
 *   - Config    — 模型提供者创建、任务路由、分类注册表 API
 *   - Generators — 可插拔代码生成器（React / Vue / Svelte / Vanilla）
 *   - Agents    — 各阶段的 AI Agent 运行函数（精炼、设计、规划、生成、审计、组装）
 *   - Session   — 会话上下文管理（会话快照、上下文追踪）
 *   - Middleware — 中间件（成本追踪、缓存、遥测）
 *   - Rules     — 静态分析规则引擎（安全、无障碍、性能）
 *   - Tools     — AI SDK 工具定义（设计、代码、审计、项目、组装、联网、共享）
 *   - Utils     — 共享工具函数（JSON 安全解析、流消费）
 *
 * v5 版本新增：项目规划（Project Planner）和代码组装（Code Assembler）能力。
 */

import 'dotenv/config';

// ── 公共 API 导出 ────────────────────────────────────

// ── Config —— 模型提供者、任务路由和分类系统 ──
export { createProviders, getWrappedModel, routeModel } from './config/index.js';
export { classifyTask, detectCrossLayer } from './config/index.js';
// 分类注册表 API —— 支持运行时扩展大型库等自定义类别
export {
  registerViewCategory,
  registerLogicCategory,
  unregisterCategory,
  getRegisteredCategories,
  getCategoriesByLayer,
  extendCategoryKeywords,
  updateCategoryRouting,
} from './config/index.js';
export type {
  AllProviders,
  ModelTier,
  TaskType,
  TaskLayer,
  ViewCategory,
  LogicCategory,
  BuiltinViewCategory,
  BuiltinLogicCategory,
  TaskClassification,
  CategoryRegistration,
  RoutingEntry,
} from './config/index.js';

// ── Generators —— 可插拔的多框架代码生成器 ──
export { getCodeGenerator, listCodeGenerators } from './generators/index.js';
export { resolveFrameworkFromUserInput } from './generators/router.js';

// ── Agents —— 各阶段的 AI Agent 运行函数 ──
export {
  runOrchestrator,
  runPromptRefiner,
  runDesignAnalyzer,
  runProjectPlanner,
  runCodeProducer,
  runCodeAuditor,
  runCodeAssembler,
  // Legacy page assembler (deprecated — use runCodeAssembler instead)
  initializePageAssembly,
  assemblePageIncrementally,
  appendComponentToAssembly,
} from './agents/index.js';
export type {
  OrchestratorResult,
  RefinedRequirement,
  DesignOutput,
  ProjectStructure,
  ProjectPlannerResult,
  ProjectFileEntry,
  ComponentMapping,
  CodeOutput,
  CodeProducerResult,
  AuditOutput,
  AssemblyResult,
  AssembledFile,
  // Legacy
  AssembledPageResult,
} from './agents/index.js';

// ── Session —— 会话上下文管理（断点续传、上下文追踪）──
export { SessionManager, ContextTracker } from './session/index.js';
export type {
  SessionSnapshot,
  HandoffPackage,
  MigrationRecord,
  ContextUsage,
} from './session/index.js';

// ── Middleware —— 成本追踪 ──
export {
  printCostReport,
  getCostRecords,
  getTotalCost,
  getCostByModel,
  resetCostRecords,
} from './middleware/index.js';

// ── Middleware —— 缓存 ──
export {
  cacheMiddleware,
  createCacheMiddleware,
  getDefaultCache,
  type CacheStore,
} from './middleware/index.js';

// ── Middleware —— 遥测（Telemetry）──
export {
  frontendAgentTelemetry,
  onTelemetryEvent,
  getTelemetryLog,
  resetTelemetryLog,
  getTelemetryStats,
  type TelemetryEvent,
  type TelemetryEventHandler,
} from './middleware/index.js';

// ── Rules —— 静态分析规则引擎（供外部直接使用）──
export { scanSecurity, scanA11y, scanPerformance } from './rules/index.js';

// ── Tools —— AI SDK 工具定义（供外部自定义 Agent 时复用）──
export {
  decomposeRequirement,
  planResponsiveStrategy,
  planStateManagement,
} from './tools/design/index.js';
export {
  scaffoldComponent,
  generateStyles,
  addInteractions,
  selfReview,
} from './tools/code/index.js';
export {
  securityScanTool,
  a11yScanTool,
  performanceScanTool,
  fullAuditTool,
} from './tools/audit/index.js';
export { analyzeComplexity, qualityGate } from './tools/shared/index.js';
export {
  planProjectStructure,
  generateConfigFile,
  inferDependencies,
  generateScaffoldCommands,
} from './tools/project/index.js';
export {
  placeComponent,
  generateEntryFiles,
  generateBarrelExports,
  fixImportPaths,
  mergeStyles,
  writeProjectToDisk,
} from './tools/assembly/index.js';
export { webSearch, fetchUrl, npmPackageInfo, fetchDocSnippet } from './tools/web/index.js';

// ── Utils —— 共享工具函数 ──
export { safeParseJson } from './utils/json.js';
export { consumeTextStream, type StreamConsumeOptions } from './utils/streaming.js';
