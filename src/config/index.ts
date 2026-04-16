export { createProviders, type AllProviders, type ProviderConfig } from './providers.js';
export { getWrappedModel, routeModel, type ModelTier, type TaskType } from './models.js';
export {
  // 分类核心函数
  classifyTask,
  detectCrossLayer,
  // 注册表 API
  registerViewCategory,
  registerLogicCategory,
  unregisterCategory,
  getRegisteredCategories,
  getCategoriesByLayer,
  extendCategoryKeywords,
  updateCategoryRouting,
  // 类型
  type TaskLayer,
  type ViewCategory,
  type LogicCategory,
  type BuiltinViewCategory,
  type BuiltinLogicCategory,
  type TaskClassification,
  type CategoryRegistration,
  type RoutingEntry,
} from './task-taxonomy.js';
