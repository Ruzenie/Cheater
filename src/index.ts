/**
 * index.ts — 前端 Agent 系统入口（v5 — 项目规划 + 代码组装）
 *
 * 导出所有公共 API，也作为 CLI 直接运行的入口。
 */

import 'dotenv/config';

// ── 公共 API 导出 ────────────────────────────────────

// Config
export { createProviders, getWrappedModel, routeModel } from './config/index.js';
export { classifyTask, detectCrossLayer } from './config/index.js';
// 分类注册表 API（运行时扩展大型库等类别）
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

// Generators
export { getCodeGenerator, listCodeGenerators } from './generators/index.js';
export { resolveFrameworkFromUserInput } from './generators/router.js';

// Agents
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

// Session (会话上下文管理)
export { SessionManager, ContextTracker } from './session/index.js';
export type {
  SessionSnapshot,
  HandoffPackage,
  MigrationRecord,
  ContextUsage,
} from './session/index.js';

// Middleware — 成本追踪
export {
  printCostReport,
  getCostRecords,
  getTotalCost,
  getCostByModel,
  resetCostRecords,
} from './middleware/index.js';

// Middleware — 缓存
export {
  cacheMiddleware,
  createCacheMiddleware,
  getDefaultCache,
  type CacheStore,
} from './middleware/index.js';

// Middleware — Telemetry
export {
  frontendAgentTelemetry,
  onTelemetryEvent,
  getTelemetryLog,
  resetTelemetryLog,
  getTelemetryStats,
  type TelemetryEvent,
  type TelemetryEventHandler,
} from './middleware/index.js';

// Rules (供外部直接使用规则引擎)
export { scanSecurity, scanA11y, scanPerformance } from './rules/index.js';

// Tools (供外部自定义 Agent 时复用)
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

// Utils (共享工具函数)
export { safeParseJson } from './utils/json.js';
export { consumeTextStream, type StreamConsumeOptions } from './utils/streaming.js';
