/**
 * @file middleware/index.ts — 中间件模块的桶导出（Barrel Exports）
 *
 * @description
 * 本文件是 Cheater 系统中所有 AI SDK 中间件的统一入口。
 * 将各个中间件模块的公开 API 集中导出，便于外部一次性导入。
 *
 * 在 Cheater 的多模型前端代码生成管线中，中间件通过 AI SDK v6 的
 * LanguageModelV3Middleware 接口，以"洋葱模型"的方式包裹 LLM 调用，
 * 实现缓存、成本追踪、输出矫正、Prompt 增强、遥测等横切关注点。
 *
 * 导出的中间件模块：
 *   - outputNormalizerMiddleware — 输出格式矫正（去 code fence、尾逗号、废话前缀）
 *   - promptEnhancerMiddleware  — Prompt 增强（为弱模型追加结构化约束）
 *   - costTrackerMiddleware     — 成本追踪（记录 token 消耗与美元成本）
 *   - cacheMiddleware           — LLM 响应缓存（减少开发调试时的重复 API 调用）
 *   - frontendAgentTelemetry    — 遥测集成（LLM 调用全生命周期事件收集）
 */

export { outputNormalizerMiddleware } from './output-normalizer.js';
export { promptEnhancerMiddleware } from './prompt-enhancer.js';
export {
  costTrackerMiddleware,
  getCostRecords,
  getTotalCost,
  getCostByModel,
  printCostReport,
  resetCostRecords,
  type CostRecord,
} from './cost-tracker.js';
export {
  cacheMiddleware,
  createCacheMiddleware,
  getDefaultCache,
  type CacheStore,
} from './cache.js';
export {
  frontendAgentTelemetry,
  onTelemetryEvent,
  getTelemetryLog,
  resetTelemetryLog,
  getTelemetryStats,
  type TelemetryEvent,
  type TelemetryEventHandler,
} from './telemetry.js';
