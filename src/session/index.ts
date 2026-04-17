/**
 * @file session/index.ts — 会话管理模块的桶导出（Barrel Exports）
 *
 * @description
 * 本文件是 Cheater 系统中会话管理和断点恢复功能的统一入口。
 * 将上下文管理器和检查点系统的公开 API 集中导出。
 *
 * 在 Cheater 系统中的角色：
 *   会话管理解决两个核心问题：
 *     1. 崩溃恢复：通过 checkpoint 系统，在 pipeline 每个步骤完成后
 *        持久化中间结果，崩溃后可从断点恢复，避免重复调用 API
 *     2. 上下文溢出：通过 context-manager 追踪 token 使用量，
 *        在接近模型上下文上限时提前触发会话迁移
 *
 * 导出的模块：
 *   - SessionManager / ContextTracker — 会话生命周期管理与上下文追踪
 *   - checkpoint 相关函数 — Pipeline 断点的创建、保存、加载、恢复
 */

export {
  SessionManager,
  ContextTracker,
  type SessionSnapshot,
  type HandoffPackage,
  type MigrationRecord,
  type CompletedItem,
  type Decision,
  type NextStep,
  type ContextUsage,
} from './context-manager.js';

export {
  type PipelineCheckpoint,
  type PipelineStep,
  PIPELINE_STEPS,
  createCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  findResumableCheckpoint,
  isStepCompleted,
  getNextStep,
} from './checkpoint.js';
