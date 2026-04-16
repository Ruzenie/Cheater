/**
 * session/checkpoint.ts — Pipeline 断点恢复系统
 *
 * 核心思路：
 *   每个 pipeline step 完成后持久化中间结果到磁盘（checkpoint）。
 *   如果 pipeline 在中途崩溃（OOM、网络错误、进程被杀），
 *   下次启动时自动检测最新 checkpoint 并从断点恢复，
 *   跳过已完成的步骤，避免重复花钱调 API。
 *
 * 文件存储位置：.session-data/checkpoints/<sessionId>.json
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

export type PipelineStep =
  | 'refine' // Step 0
  | 'classify' // Step 1 (零成本，但保存 classification 结果)
  | 'design' // Step 2
  | 'plan+code' // Step 3+4 (fork-join)
  | 'audit' // Step 5
  | 'assemble'; // Step 6

/** Step 的有序列表，用于判断恢复位置 */
export const PIPELINE_STEPS: PipelineStep[] = [
  'refine',
  'classify',
  'design',
  'plan+code',
  'audit',
  'assemble',
];

// ── Checkpoint 数据结构 ──

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

const CHECKPOINT_DIR = '.session-data/checkpoints';

/** 获取 checkpoint 文件路径 */
function getCheckpointPath(sessionId: string, storageDir?: string): string {
  const baseDir = storageDir ?? CHECKPOINT_DIR;
  return path.resolve(baseDir, `${sessionId}.json`);
}

/** 保存 checkpoint 到磁盘 */
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

/** 从磁盘加载 checkpoint（不存在则返回 null） */
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

/** 删除 checkpoint（pipeline 成功完成后清理） */
export function deleteCheckpoint(sessionId: string, storageDir?: string): void {
  const filePath = getCheckpointPath(sessionId, storageDir);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * 自动查找可恢复的 checkpoint。
 * 使用标准化后的 requirement 匹配，容忍空白、标点和措辞的细微差异。
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

  // 按修改时间倒序，取最新的匹配项
  const candidates: Array<{ checkpoint: PipelineCheckpoint; mtime: number }> = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as PipelineCheckpoint;

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

  // 取最新的
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].checkpoint;
}

/**
 * 标准化 requirement 文本，用于匹配时容忍细微差异：
 * - 去除首尾空白
 * - 折叠连续空白为单个空格
 * - 去除标点符号差异（。，！？等）
 * - 统一为小写
 *
 * 这样 "创建一个 Todo 应用" 和 "创建一个Todo应用。" 会被视为同一个任务。
 */
function normalizeRequirement(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：""''「」【】（）\s]+/g, ' ')
    .replace(/[,.\-!?;:'"()\[\]{}\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 创建空白 checkpoint */
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

/** 判断某个 step 是否已经在 checkpoint 中完成 */
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
