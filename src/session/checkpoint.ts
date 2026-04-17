/**
 * @file session/checkpoint.ts — Pipeline 断点恢复系统
 *
 * @description
 * 本文件实现了 Cheater 代码生成管线的崩溃恢复机制。
 *
 * 核心思路：
 *   每个 pipeline step 完成后，将中间结果序列化为 JSON 并持久化到磁盘。
 *   如果 pipeline 在中途崩溃（OOM、网络错误、进程被杀），
 *   下次启动时自动检测最新的 checkpoint 并从断点恢复，
 *   跳过已完成的步骤，避免重复花钱调 API。
 *
 * 在 Cheater 系统中的角色：
 *   多模型管线包含多个耗时且有成本的步骤（refine → classify → design →
 *   plan+code → audit → assemble）。任何一步失败都不应导致从头开始。
 *   checkpoint 系统确保了管线的"幂等恢复"能力。
 *
 * 数据存储：
 *   - 文件位置：.session-data/checkpoints/<sessionId>.json
 *   - 格式：JSON，包含版本号、各步骤中间结果、选项配置等
 *   - 匹配策略：基于标准化后的 requirement 文本，容忍空白和标点差异
 *
 * Pipeline 步骤枚举：
 *   refine → classify → design → plan+code → audit → assemble
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RefinedRequirement } from '../agents/prompt-refiner.js';
import type { DesignOutput } from '../agents/design-analyzer.js';
import type { ProjectPlannerResult } from '../agents/project-planner.js';
import type { CodeProducerResult } from '../agents/code-producer.js';
import type { AuditOutput } from '../agents/code-auditor.js';
import type { AssemblyResult } from '../agents/code-assembler.js';
import type { TaskClassification } from '../config/task-taxonomy.js';

// ── Pipeline Step 枚举 ──

/**
 * Pipeline 步骤标识符
 *
 * @description
 * 管线的六个阶段：
 *   - 'refine': Step 0 — 需求精炼（用 LLM 将模糊需求转化为结构化需求）
 *   - 'classify': Step 1 — 任务分类（零成本，但保存分类结果供后续路由）
 *   - 'design': Step 2 — 设计分析（组件结构、交互模式、状态管理方案）
 *   - 'plan+code': Step 3+4 — 规划 + 代码生产（fork-join 并行执行）
 *   - 'audit': Step 5 — 代码审计（安全/无障碍/性能检查 + LLM 审计）
 *   - 'assemble': Step 6 — 代码组装（将多文件代码整合为最终产出）
 */
export type PipelineStep =
  | 'refine' // Step 0
  | 'classify' // Step 1 (零成本，但保存 classification 结果)
  | 'design' // Step 2
  | 'plan+code' // Step 3+4 (fork-join)
  | 'audit' // Step 5
  | 'assemble'; // Step 6

/**
 * Step 的有序列表
 *
 * @description
 * 用于判断恢复位置：通过比较 lastCompletedStep 在数组中的索引，
 * 确定下一个需要执行的步骤。
 */
export const PIPELINE_STEPS: PipelineStep[] = [
  'refine',
  'classify',
  'design',
  'plan+code',
  'audit',
  'assemble',
];

// ── Checkpoint 数据结构 ──

/**
 * Pipeline 检查点数据结构
 *
 * @description
 * 包含管线运行的完整快照：版本信息、配置选项、各步骤的中间结果。
 * 每完成一步就更新对应字段，并持久化到磁盘。
 * 加载时通过 version 字段进行兼容性检查。
 */
export interface PipelineCheckpoint {
  /** checkpoint 版本，用于兼容性检查 */
  version: 1;
  /** 会话 ID */
  sessionId: string;
  /** 原始需求（用于校验是否同一个任务） */
  requirement: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 最后成功完成的 step */
  lastCompletedStep: PipelineStep | null;
  /** 已花费的成本（美元） */
  costSoFar: number;
  /** 已消耗的迭代轮数 */
  iterationsSoFar: number;

  // ── 各步骤的中间结果（每完成一步就填入对应字段）──

  /** 输入选项（恢复时需要） */
  options: {
    framework: string;
    styleMethod: string;
    darkMode: boolean;
    skipDeepAnalysis: boolean;
    skipRefine: boolean;
    concurrency: number;
    packageManager: string;
    projectName?: string;
    writeToFS: boolean;
    outputDir?: string;
    budgetLimit: number;
    maxContextTokens: number;
  };

  /** Step 0 结果 */
  refined?: RefinedRequirement;
  /** effectiveRequirement（精炼后或原始） */
  effectiveRequirement?: string;
  /** 解析后的框架 */
  resolvedFramework?: string;

  /** Step 1 结果 */
  classification?: TaskClassification;
  crossLayer?: { isCrossLayer: boolean; viewScore: number; logicScore: number };
  pipeline?: { design: boolean; plan: boolean; code: boolean; audit: boolean; assemble: boolean };

  /** Step 2 结果 */
  design?: DesignOutput;

  /** Step 3+4 结果 */
  plan?: ProjectPlannerResult;
  code?: CodeProducerResult;

  /** Step 5 结果 */
  audit?: AuditOutput;
  /** 审计时的当前迭代轮次 */
  auditIteration?: number;

  /** Step 6 结果 */
  assembly?: AssemblyResult;
}

// ── 存取函数 ──

/** 默认的 checkpoint 存储目录 */
const CHECKPOINT_DIR = '.session-data/checkpoints';

/**
 * 获取 checkpoint 文件路径
 * @param sessionId - 会话 ID
 * @param storageDir - 可选的自定义存储目录
 * @returns 完整的文件路径
 */
function getCheckpointPath(sessionId: string, storageDir?: string): string {
  const baseDir = storageDir ?? CHECKPOINT_DIR;
  return path.resolve(baseDir, `${sessionId}.json`);
}

/**
 * 保存 checkpoint 到磁盘
 *
 * @description
 * 将 checkpoint 对象序列化为 JSON 并写入文件。
 * 自动创建目录（如不存在），并更新 updatedAt 时间戳。
 *
 * @param checkpoint - 要保存的 checkpoint 对象
 * @param storageDir - 可选的自定义存储目录
 * @returns 保存的文件路径
 */
export function saveCheckpoint(checkpoint: PipelineCheckpoint, storageDir?: string): string {
  const filePath = getCheckpointPath(checkpoint.sessionId, storageDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  checkpoint.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');

  return filePath;
}

/**
 * 从磁盘加载 checkpoint
 *
 * @description
 * 读取并解析 checkpoint JSON 文件。包含版本兼容性检查：
 * 如果版本不匹配，返回 null 并输出警告。
 * 如果文件不存在或已损坏，同样返回 null。
 *
 * @param sessionId - 会话 ID
 * @param storageDir - 可选的自定义存储目录
 * @returns checkpoint 对象，不存在或不兼容则返回 null
 */
export function loadCheckpoint(sessionId: string, storageDir?: string): PipelineCheckpoint | null {
  const filePath = getCheckpointPath(sessionId, storageDir);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as PipelineCheckpoint;

    // 版本兼容性检查
    if (data.version !== 1) {
      console.warn(`⚠️  Checkpoint 版本不兼容 (v${data.version})，将忽略`);
      return null;
    }

    return data;
  } catch (err) {
    console.warn(`⚠️  Checkpoint 文件损坏，将忽略：${filePath}`, err);
    return null;
  }
}

/**
 * 删除 checkpoint 文件
 *
 * @description
 * 在 pipeline 成功完成后调用，清理不再需要的 checkpoint 文件。
 *
 * @param sessionId - 会话 ID
 * @param storageDir - 可选的自定义存储目录
 */
export function deleteCheckpoint(sessionId: string, storageDir?: string): void {
  const filePath = getCheckpointPath(sessionId, storageDir);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * 自动查找可恢复的 checkpoint
 *
 * @description
 * 扫描 checkpoint 目录中的所有 JSON 文件，通过标准化后的 requirement
 * 文本进行匹配。匹配规则容忍空白、标点和大小写的细微差异，
 * 例如 "创建一个 Todo 应用" 和 "创建一个Todo应用。" 会被视为同一个任务。
 *
 * 匹配条件：
 *   - 版本为 1
 *   - 标准化后的 requirement 完全一致
 *   - 尚未完成（lastCompletedStep !== 'assemble'）
 *
 * 如有多个匹配，返回修改时间最新的那个。
 *
 * @param requirement - 当前的需求文本
 * @param storageDir - 可选的自定义存储目录
 * @returns 可恢复的 checkpoint，未找到则返回 null
 */
export function findResumableCheckpoint(
  requirement: string,
  storageDir?: string,
): PipelineCheckpoint | null {
  const dir = path.resolve(storageDir ?? CHECKPOINT_DIR);

  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const normalizedReq = normalizeRequirement(requirement);

  // 按修改时间倒序排列，取最新的匹配项
  const candidates: Array<{ checkpoint: PipelineCheckpoint; mtime: number }> = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as PipelineCheckpoint;

      // 校验条件：版本匹配 + 需求文本匹配 + 尚未完成最后一步
      if (
        data.version === 1 &&
        normalizeRequirement(data.requirement) === normalizedReq &&
        data.lastCompletedStep !== 'assemble'
      ) {
        candidates.push({ checkpoint: data, mtime: stat.mtimeMs });
      }
    } catch {
      // 跳过损坏的文件
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // 取修改时间最新的候选项
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].checkpoint;
}

/**
 * 标准化 requirement 文本，用于匹配时容忍细微差异
 *
 * @description
 * 标准化规则：
 *   - 去除首尾空白
 *   - 折叠连续空白为单个空格
 *   - 去除中文标点符号差异（。，！？等）
 *   - 去除英文标点符号差异（,.-!? 等）
 *   - 统一为小写
 *
 * 这样 "创建一个 Todo 应用" 和 "创建一个Todo应用。" 会被视为同一个任务。
 *
 * @param text - 原始需求文本
 * @returns 标准化后的文本
 */
function normalizeRequirement(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // 第一步：将中文标点和空白字符替换为空格
    .replace(/[，。！？、；：""''「」【】（）\s]+/g, ' ')
    // 第二步：将英文标点和空白字符替换为空格
    .replace(/[,.\-!?;:'"()\[\]{}\s]+/g, ' ')
    // 第三步：折叠连续空格
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 创建空白 checkpoint
 *
 * @description
 * 在 pipeline 开始时调用，初始化一个没有任何已完成步骤的 checkpoint。
 * 后续每完成一步就更新对应字段并调用 saveCheckpoint 持久化。
 *
 * @param sessionId - 会话 ID（通常由 UUID 生成）
 * @param requirement - 用户的原始需求文本
 * @param options - pipeline 的运行选项（框架、样式方法、并发数等）
 * @returns 初始化的 checkpoint 对象
 */
export function createCheckpoint(
  sessionId: string,
  requirement: string,
  options: PipelineCheckpoint['options'],
): PipelineCheckpoint {
  return {
    version: 1,
    sessionId,
    requirement,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCompletedStep: null,
    costSoFar: 0,
    iterationsSoFar: 0,
    options,
  };
}

/**
 * 判断某个 step 是否已经在 checkpoint 中完成
 *
 * @description
 * 通过比较 step 在 PIPELINE_STEPS 数组中的索引与 lastCompletedStep 的索引，
 * 如果 step 的索引 <= lastCompletedStep 的索引，则认为已完成。
 *
 * @param checkpoint - checkpoint 对象
 * @param step - 要检查的步骤
 * @returns 如果该步骤已完成则返回 true
 */
export function isStepCompleted(checkpoint: PipelineCheckpoint, step: PipelineStep): boolean {
  if (!checkpoint.lastCompletedStep) return false;

  const lastIdx = PIPELINE_STEPS.indexOf(checkpoint.lastCompletedStep);
  const stepIdx = PIPELINE_STEPS.indexOf(step);

  return stepIdx <= lastIdx;
}

/** 获取下一个需要执行的 step */
export function getNextStep(checkpoint: PipelineCheckpoint): PipelineStep | null {
  if (!checkpoint.lastCompletedStep) {
    return PIPELINE_STEPS[0];
  }

  const lastIdx = PIPELINE_STEPS.indexOf(checkpoint.lastCompletedStep);
  if (lastIdx >= PIPELINE_STEPS.length - 1) {
    return null; // 全部完成
  }

  return PIPELINE_STEPS[lastIdx + 1];
}
