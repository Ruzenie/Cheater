/**
 * @file config/index.ts — 配置模块统一出口
 *
 * 本文件是 Cheater 系统配置层的"大门"，负责将三个子模块的公共 API
 * 以统一入口重新导出，供上层消费方（如 agents、generators、tools）直接引用。
 *
 * 架构角色：
 *   - 作为 barrel file（桶文件），简化外部 import 路径，
 *     使用者只需 `import { ... } from './config/index.js'` 即可获取所有配置能力。
 *   - 不包含任何业务逻辑，仅做转发。
 *
 * 子模块职责一览：
 *   1. providers.ts  — 初始化 OpenAI 兼容的 LLM Provider 实例（executor / worker / reasoner）
 *   2. models.ts     — 模型分级路由 + 中间件包裹（缓存、成本追踪、输出矫正、prompt 增强）
 *   3. task-taxonomy.ts — 零成本任务分类体系（基于关键词注册表，无需调用 LLM）
 */

// ── Provider 初始化相关 ──────────────────────────────────
export { createProviders, type AllProviders, type ProviderConfig } from './providers.js';

// ── 模型路由与中间件包裹 ─────────────────────────────────
export { getWrappedModel, routeModel, type ModelTier, type TaskType } from './models.js';

// ── 任务分类体系 ─────────────────────────────────────────
export {
  // 分类核心函数
  /** 对前端需求文本进行自动分类（零 LLM 成本） */
  classifyTask,
  /** 检测需求是否同时涉及交互层和逻辑层，用于拆分并行子任务 */
  detectCrossLayer,

  // 注册表 API — 运行时动态扩展分类体系
  /** 注册一个交互层（View）分类 */
  registerViewCategory,
  /** 注册一个逻辑层（Logic）分类 */
  registerLogicCategory,
  /** 注销已注册的分类 */
  unregisterCategory,
  /** 获取所有已注册分类的只读列表 */
  getRegisteredCategories,
  /** 按层级筛选已注册分类 */
  getCategoriesByLayer,
  /** 为已注册分类追加关键词 */
  extendCategoryKeywords,
  /** 更新已注册分类的路由配置 */
  updateCategoryRouting,

  // 类型导出
  type TaskLayer,
  type ViewCategory,
  type LogicCategory,
  type BuiltinViewCategory,
  type BuiltinLogicCategory,
  type TaskClassification,
  type CategoryRegistration,
  type RoutingEntry,
} from './task-taxonomy.js';
