/**
 * @file session/context-manager.ts — 会话上下文管理与交接系统
 *
 * @description
 * 本文件实现了 Cheater 系统的会话上下文管理、溢出检测和跨会话交接机制。
 * 核心目标是解决弱模型（如 doubao-lite）上下文窗口有限的问题。
 *
 * 在 Cheater 系统中的角色：
 *   弱模型的上下文窗口通常只有 32K-128K token，而一个完整的前端代码
 *   生成任务可能需要大量的上下文（需求、设计、已生成代码、审计反馈等）。
 *   当上下文接近上限时，需要将当前会话的状态"交接"到新会话中继续。
 *
 * 八步交接策略：
 *   1) 提前触发：70%~80% 就开始准备迁移（而非等到溢出）
 *   2) 冻结会话：停止新增实现，做状态快照
 *   3) 生成交接包：压缩为只含关键信息的紧凑格式
 *   4) 固定模板：新会话使用标准化开场模板
 *   5) 一致性校验：新会话先复述任务再执行
 *   6) 双会话并行：旧会话核对结果，新会话执行任务
 *   7) 关键事实外置：决策和状态写入外部存储
 *   8) 迁移追溯：记录完整的会话迁移链路
 *
 * 主要组件：
 *   - ContextTracker: 追踪 token 使用量，检测溢出风险
 *   - SessionManager: 管理会话完整生命周期（创建 → 追踪 → 快照 → 交接 → 迁移）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ══════════════════════════════════════════════════════
//  类型定义 — 会话状态、交接包、迁移记录
// ══════════════════════════════════════════════════════

/**
 * 会话状态快照
 *
 * @description
 * 记录当前会话的完整状态，用于生成交接包或持久化到磁盘。
 * 包含目标、已完成工作、决策、阻塞点、下一步待办等信息。
 */
export interface SessionSnapshot {
  sessionId: string;
  createdAt: string;
  /** 目标与范围 */
  objective: string;
  scope: string[];
  /** 已完成结果 */
  completedItems: CompletedItem[];
  /** 关键决策与原因 */
  decisions: Decision[];
  /** 当前阻塞点/风险 */
  blockers: string[];
  risks: string[];
  /** 下一步待办（按优先级） */
  nextSteps: NextStep[];
  /** 当前代码产出（文件名 → 代码摘要） */
  codeArtifacts: Record<string, string>;
  /** 上下文使用量 */
  contextUsage: ContextUsage;
}

/**
 * 已完成的工作项
 */
export interface CompletedItem {
  /** 工作项描述 */
  description: string;
  /** 简短的结果摘要 */
  result: string;
  /** 完成该工作项所使用的模型标识 */
  modelUsed: string;
}

/**
 * 关键决策记录
 *
 * @description
 * 记录 pipeline 运行过程中做出的关键架构/技术决策，
 * 确保会话迁移后新会话能理解之前的设计选择。
 */
export interface Decision {
  /** 决定了什么 */
  what: string;
  /** 为什么这样决定 */
  why: string;
  /** 考虑过但被排除的替代方案 */
  alternatives: string[];
}

/**
 * 下一步待办项
 */
export interface NextStep {
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 待办描述 */
  description: string;
  /** 预估所需的 token 数量 */
  estimatedTokens: number;
  /** 被哪个其他任务阻塞（可选） */
  blockedBy?: string;
}

/**
 * 上下文使用量统计
 */
export interface ContextUsage {
  /** 当前已使用的 token 数量 */
  currentTokens: number;
  /** 最大可用 token 数量 */
  maxTokens: number;
  /** 使用百分比（0-100） */
  usagePercent: number;
}

/**
 * 交接包
 *
 * @description
 * 从旧会话迁移到新会话时传递的完整信息包。
 * 包含状态快照、开场模板和一致性校验问题。
 */
export interface HandoffPackage {
  /** 交接版本号（递增，用于追溯） */
  version: string;
  /** 交接时间戳 */
  timestamp: string;
  /** 源会话 ID */
  sourceSessionId: string;
  /** 目标会话 ID（新会话创建后回填） */
  targetSessionId?: string;
  /** 状态快照 */
  snapshot: SessionSnapshot;
  /** 新会话的固定开场模板（Markdown 格式） */
  openingTemplate: string;
  /** 一致性校验问题列表（新会话需要回答） */
  verificationQuestions: string[];
}

/**
 * 迁移记录
 *
 * @description
 * 记录每次会话迁移的完整信息，形成可追溯的迁移链路。
 */
export interface MigrationRecord {
  /** 迁移记录唯一 ID */
  id: string;
  /** 迁移时间戳 */
  timestamp: string;
  /** 源会话 ID */
  fromSessionId: string;
  /** 目标会话 ID */
  toSessionId: string;
  /** 使用的交接包版本 */
  handoffVersion: string;
  /** 迁移状态：pending=待验证, verified=已验证, completed=已完成, failed=失败 */
  status: 'pending' | 'verified' | 'completed' | 'failed';
  /** 备注信息 */
  notes: string;
}

// ══════════════════════════════════════════════════════
//  上下文追踪器 — 监控 token 使用量，检测溢出风险
// ══════════════════════════════════════════════════════

/**
 * 上下文使用量追踪器
 *
 * @description
 * 追踪当前会话的 token 使用量，在接近上限时提前预警。
 *
 * 核心策略：
 *   - warning 阈值（默认 70%）：开始准备迁移材料
 *   - critical 阈值（默认 85%）：立即执行迁移
 *   - overflow：已超出上限，紧急迁移
 *
 * 使用 predict() 方法可以在执行任务前预估是否会溢出，
 * 避免在执行到一半时才发现上下文不够。
 */
export class ContextTracker {
  /** 当前已使用的 token 数量 */
  private currentTokens = 0;
  /** 最大可用 token 数量 */
  private readonly maxTokens: number;
  /** 警告阈值（token 数量）——默认为 maxTokens 的 70% */
  private readonly warningThreshold: number;
  /** 临界阈值（token 数量）——默认为 maxTokens 的 85% */
  private readonly criticalThreshold: number;

  /**
   * @param maxTokens - 模型的最大上下文 token 数量
   * @param options - 可选的阈值百分比配置
   * @param options.warningPercent - 警告阈值百分比（默认 0.7）
   * @param options.criticalPercent - 临界阈值百分比（默认 0.85）
   */
  constructor(
    maxTokens: number,
    options: { warningPercent?: number; criticalPercent?: number } = {},
  ) {
    this.maxTokens = maxTokens;
    // 根据百分比计算实际的 token 阈值
    this.warningThreshold = maxTokens * (options.warningPercent ?? 0.7);
    this.criticalThreshold = maxTokens * (options.criticalPercent ?? 0.85);
  }

  /**
   * 记录 token 消耗
   * @param count - 本次消耗的 token 数量
   */
  addTokens(count: number): void {
    this.currentTokens += count;
  }

  /** 获取当前使用状态 */
  getUsage(): ContextUsage {
    return {
      currentTokens: this.currentTokens,
      maxTokens: this.maxTokens,
      usagePercent: Math.round((this.currentTokens / this.maxTokens) * 100),
    };
  }

  /** 检查是否需要迁移 */
  checkStatus(): 'ok' | 'warning' | 'critical' | 'overflow' {
    if (this.currentTokens >= this.maxTokens) return 'overflow';
    if (this.currentTokens >= this.criticalThreshold) return 'critical';
    if (this.currentTokens >= this.warningThreshold) return 'warning';
    return 'ok';
  }

  /** 预估添加 N 个 token 后的状态 */
  predict(additionalTokens: number): 'ok' | 'warning' | 'critical' | 'overflow' {
    const predicted = this.currentTokens + additionalTokens;
    if (predicted >= this.maxTokens) return 'overflow';
    if (predicted >= this.criticalThreshold) return 'critical';
    if (predicted >= this.warningThreshold) return 'warning';
    return 'ok';
  }

  /** 剩余可用 token */
  remaining(): number {
    return Math.max(0, this.maxTokens - this.currentTokens);
  }

  reset(): void {
    this.currentTokens = 0;
  }
}

// ══════════════════════════════════════════════════════
//  会话管理器
// ══════════════════════════════════════════════════════

/**
 * 管理会话生命周期：创建 → 追踪 → 快照 → 交接 → 迁移
 */
export class SessionManager {
  private readonly storageDir: string;
  private snapshot: SessionSnapshot;
  private contextTracker: ContextTracker;
  private migrationHistory: MigrationRecord[] = [];

  constructor(
    sessionId: string,
    options: {
      storageDir?: string;
      maxTokens?: number;
      objective?: string;
    } = {},
  ) {
    this.storageDir = options.storageDir ?? './.session-data';
    this.contextTracker = new ContextTracker(options.maxTokens ?? 32000);

    this.snapshot = {
      sessionId,
      createdAt: new Date().toISOString(),
      objective: options.objective ?? '',
      scope: [],
      completedItems: [],
      decisions: [],
      blockers: [],
      risks: [],
      nextSteps: [],
      codeArtifacts: {},
      contextUsage: this.contextTracker.getUsage(),
    };
  }

  // ── 会话状态更新 ─────────────────────────────────

  /** 记录完成的工作项 */
  addCompleted(item: CompletedItem): void {
    this.snapshot.completedItems.push(item);
  }

  /** 记录决策 */
  addDecision(decision: Decision): void {
    this.snapshot.decisions.push(decision);
  }

  /** 记录代码产出 */
  addCodeArtifact(fileName: string, codeSummary: string): void {
    this.snapshot.codeArtifacts[fileName] = codeSummary;
  }

  /** 更新下一步待办 */
  setNextSteps(steps: NextStep[]): void {
    this.snapshot.nextSteps = steps;
  }

  /** 添加阻塞点 */
  addBlocker(blocker: string): void {
    this.snapshot.blockers.push(blocker);
  }

  /** 添加风险 */
  addRisk(risk: string): void {
    this.snapshot.risks.push(risk);
  }

  /** 记录 token 使用 */
  trackTokens(count: number): void {
    this.contextTracker.addTokens(count);
    this.snapshot.contextUsage = this.contextTracker.getUsage();
  }

  // ── 上下文检查 ──────────────────────────────────

  /** 检查是否需要迁移 */
  shouldHandoff(): { needed: boolean; reason: string; urgency: string } {
    const status = this.contextTracker.checkStatus();

    switch (status) {
      case 'overflow':
        return { needed: true, reason: '上下文已溢出！立即迁移！', urgency: 'immediate' };
      case 'critical':
        return {
          needed: true,
          reason: `上下文使用 ${this.snapshot.contextUsage.usagePercent}%，已达临界值，应立即迁移`,
          urgency: 'high',
        };
      case 'warning':
        return {
          needed: true,
          reason: `上下文使用 ${this.snapshot.contextUsage.usagePercent}%，建议准备迁移`,
          urgency: 'medium',
        };
      default:
        return {
          needed: false,
          reason: `上下文使用 ${this.snapshot.contextUsage.usagePercent}%，状态正常`,
          urgency: 'none',
        };
    }
  }

  /** 预判：如果继续执行某个任务，是否会溢出 */
  predictOverflow(estimatedTokens: number): boolean {
    return this.contextTracker.predict(estimatedTokens) === 'overflow';
  }

  // ── 交接包生成（步骤 2-3）───────────────────────

  /** 冻结当前会话并生成交接包 */
  generateHandoff(): HandoffPackage {
    const version = `v${this.migrationHistory.length + 1}_${Date.now()}`;

    const handoff: HandoffPackage = {
      version,
      timestamp: new Date().toISOString(),
      sourceSessionId: this.snapshot.sessionId,
      snapshot: structuredClone(this.snapshot),
      openingTemplate: this.buildOpeningTemplate(),
      verificationQuestions: this.buildVerificationQuestions(),
    };

    return handoff;
  }

  /** 构建固定开场模板（步骤 4） */
  private buildOpeningTemplate(): string {
    const s = this.snapshot;

    return `# 会话交接 — 请先阅读再执行

## 1. 目标与范围
**目标**：${s.objective}
**范围**：${s.scope.join(', ') || '待确认'}

## 2. 已完成工作
${
  s.completedItems.length > 0
    ? s.completedItems
        .map((item, i) => `${i + 1}. ✅ ${item.description} → ${item.result} (${item.modelUsed})`)
        .join('\n')
    : '暂无已完成项'
}

## 3. 已生成代码
${
  Object.keys(s.codeArtifacts).length > 0
    ? Object.entries(s.codeArtifacts)
        .map(([file, summary]) => `- \`${file}\`: ${summary}`)
        .join('\n')
    : '暂无代码产出'
}

## 4. 关键决策
${
  s.decisions.length > 0
    ? s.decisions
        .map((d) => `- **${d.what}**：${d.why}（排除方案：${d.alternatives.join(', ')}）`)
        .join('\n')
    : '暂无关键决策'
}

## 5. 当前阻塞点
${s.blockers.length > 0 ? s.blockers.map((b) => `- ❌ ${b}`).join('\n') : '无阻塞'}

## 6. 风险
${s.risks.length > 0 ? s.risks.map((r) => `- ⚠️ ${r}`).join('\n') : '无已知风险'}

## 7. 下一步待办（按优先级）
${
  s.nextSteps.length > 0
    ? s.nextSteps
        .map(
          (step) =>
            `- [${step.priority}] ${step.description}${step.blockedBy ? ` (blocked by: ${step.blockedBy})` : ''}`,
        )
        .join('\n')
    : '无待办'
}

---
**指令**：请先用一段话复述"我将做什么/不做什么"，待我确认后再开始执行。`;
  }

  /** 构建一致性校验问题（步骤 5） */
  private buildVerificationQuestions(): string[] {
    const questions: string[] = ['你将要完成的具体任务是什么？', '哪些工作已经完成，不需要重做？'];

    if (this.snapshot.decisions.length > 0) {
      questions.push('之前做出了哪些关键决策？你会遵循这些决策吗？');
    }
    if (this.snapshot.blockers.length > 0) {
      questions.push('当前有哪些阻塞点？你打算如何处理？');
    }
    if (this.snapshot.nextSteps.length > 0) {
      questions.push('你的下一步执行顺序是什么？优先级是否正确？');
    }

    return questions;
  }

  // ── 持久化（步骤 7）────────────────────────────

  /** 将交接包保存到文件系统 */
  saveHandoff(handoff: HandoffPackage): string {
    const dir = path.resolve(this.storageDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileName = `handoff_${handoff.sourceSessionId}_${handoff.version}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(handoff, null, 2), 'utf-8');

    return filePath;
  }

  /** 从文件加载交接包 */
  static loadHandoff(filePath: string): HandoffPackage {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as HandoffPackage;
    } catch (err) {
      throw new Error(
        `交接包加载失败 (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 保存当前快照到外部存储 */
  saveSnapshot(): string {
    const dir = path.resolve(this.storageDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileName = `snapshot_${this.snapshot.sessionId}_${Date.now()}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(this.snapshot, null, 2), 'utf-8');

    return filePath;
  }

  // ── 迁移追溯（步骤 8）────────────────────────

  /** 记录迁移事件 */
  recordMigration(
    toSessionId: string,
    handoffVersion: string,
    status: MigrationRecord['status'] = 'pending',
    notes = '',
  ): MigrationRecord {
    const record: MigrationRecord = {
      id: `migration_${Date.now()}`,
      timestamp: new Date().toISOString(),
      fromSessionId: this.snapshot.sessionId,
      toSessionId,
      handoffVersion,
      status,
      notes,
    };

    this.migrationHistory.push(record);

    // 同时持久化
    const dir = path.resolve(this.storageDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, 'migration_history.json');
    fs.writeFileSync(filePath, JSON.stringify(this.migrationHistory, null, 2), 'utf-8');

    return record;
  }

  /** 获取迁移历史 */
  getMigrationHistory(): readonly MigrationRecord[] {
    return this.migrationHistory;
  }

  // ── Getters ─────────────────────────────────────

  getSnapshot(): SessionSnapshot {
    return { ...this.snapshot };
  }

  getContextUsage(): ContextUsage {
    return this.contextTracker.getUsage();
  }

  getSessionId(): string {
    return this.snapshot.sessionId;
  }
}
