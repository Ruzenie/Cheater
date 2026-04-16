/**
 * session/context-manager.ts — 会话上下文管理与交接系统
 *
 * 解决弱模型上下文不够的核心问题：
 *
 * 1) 提前触发阈值：70%~80% 就开始迁移
 * 2) 冻结旧会话：停止新增实现，做状态快照
 * 3) 生成交接包：只保留关键信息
 * 4) 固定开场模板：新窗口标准化开场
 * 5) 一致性校验：新会话先复述再执行
 * 6) 双会话并行：旧会话核对，新会话执行
 * 7) 关键事实外置：决策/状态写入外部存储
 * 8) 迁移追溯：记录完整迁移链路
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/** 会话状态快照 */
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

export interface CompletedItem {
  description: string;
  result: string; // 简短结果摘要
  modelUsed: string; // 哪个模型完成的
}

export interface Decision {
  what: string; // 决定了什么
  why: string; // 为什么这样决定
  alternatives: string[]; // 考虑过的替代方案
}

export interface NextStep {
  priority: 'high' | 'medium' | 'low';
  description: string;
  estimatedTokens: number;
  blockedBy?: string;
}

export interface ContextUsage {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
}

/** 交接包 */
export interface HandoffPackage {
  version: string; // 交接版本号
  timestamp: string;
  sourceSessionId: string;
  targetSessionId?: string; // 新会话创建后填入
  snapshot: SessionSnapshot;
  /** 固定开场模板 */
  openingTemplate: string;
  /** 一致性校验问题 */
  verificationQuestions: string[];
}

/** 迁移记录 */
export interface MigrationRecord {
  id: string;
  timestamp: string;
  fromSessionId: string;
  toSessionId: string;
  handoffVersion: string;
  status: 'pending' | 'verified' | 'completed' | 'failed';
  notes: string;
}

// ══════════════════════════════════════════════════════
//  上下文追踪器
// ══════════════════════════════════════════════════════

/**
 * 追踪当前会话的上下文使用量
 * 核心策略：在接近上限时提前触发迁移
 */
export class ContextTracker {
  private currentTokens = 0;
  private readonly maxTokens: number;
  private readonly warningThreshold: number; // 70%
  private readonly criticalThreshold: number; // 85%

  constructor(
    maxTokens: number,
    options: { warningPercent?: number; criticalPercent?: number } = {},
  ) {
    this.maxTokens = maxTokens;
    this.warningThreshold = maxTokens * (options.warningPercent ?? 0.7);
    this.criticalThreshold = maxTokens * (options.criticalPercent ?? 0.85);
  }

  /** 记录 token 消耗 */
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
