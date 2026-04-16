/**
 * orchestrator.ts — 总调度器 Agent（v5 — 完整项目规划 + 代码组装）
 *
 *
 * Pipeline:
 *   Step 0: Prompt Refiner (executor) → 精炼需求
 *   Step 1: Framework Routing + Task Classification (零成本)
 *   Step 2: Design Analyzer (worker) → 组件树
 *   Step 3: Project Planner (worker) → 项目结构规划
 *   Step 4: Code Producer (worker/executor/reasoner) → 组件代码
 *   Step 5: Code Auditor (reasoner/executor) → 审计循环
 *   Step 6: Code Assembler (worker) → 组装完整项目
 *   Step 7: Code Auditor (reasoner/executor) → 最终审计
 */

import { type AllProviders } from '../config/index.js';
import {
  classifyTask,
  detectCrossLayer,
  type TaskClassification,
} from '../config/task-taxonomy.js';
import { getCodeGenerator } from '../generators/index.js';
import { resolveFrameworkFromUserInput } from '../generators/router.js';
import { runPromptRefiner, type RefinedRequirement } from './prompt-refiner.js';
import { runDesignAnalyzer, type DesignOutput } from './design-analyzer.js';
import { runProjectPlanner, type ProjectPlannerResult } from './project-planner.js';
import { runCodeProducer, type CodeProducerResult } from './code-producer.js';
import { runCodeAuditor, type AuditOutput } from './code-auditor.js';
import { runCodeAssembler, type AssemblyResult } from './code-assembler.js';
import { printCostReport, resetCostRecords, getTotalCost } from '../middleware/cost-tracker.js';
import { resetTelemetryLog } from '../middleware/telemetry.js';
import { SessionManager, type HandoffPackage } from '../session/index.js';
import {
  createCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  findResumableCheckpoint,
  isStepCompleted,
  getNextStep,
  type PipelineCheckpoint,
} from '../session/checkpoint.js';
import path from 'node:path';

// ── 输出类型 ──────────────────────────────────────────

export interface OrchestratorResult {
  requirement: string;
  /** 精炼后的需求（如果启用了 Prompt Refiner） */
  refinedRequirement?: RefinedRequirement;
  /** 多维分类结果 */
  classification: TaskClassification;
  /** 是否跨层 */
  crossLayer: { isCrossLayer: boolean; viewScore: number; logicScore: number };
  pipeline: { design: boolean; plan: boolean; code: boolean; audit: boolean; assemble: boolean };
  design?: DesignOutput;
  /** v5: 项目结构规划 */
  plan?: ProjectPlannerResult;
  code?: CodeProducerResult;
  audit?: AuditOutput;
  /** v5: 组装后的完整项目 */
  assembly?: AssemblyResult;
  iterations: number;
  finalVerdict: 'passed' | 'failed' | 'partial';
  /** 会话交接包（如果触发了迁移） */
  handoff?: HandoffPackage;
  /** 总成本 */
  totalCost: number;
}

// ── 配置 ──────────────────────────────────────────────

const MAX_ITERATIONS = 3;
const QUALITY_THRESHOLD = 7;
/** 默认预算上限（美元） */
const DEFAULT_BUDGET_LIMIT = 5.0;

// ── 预算检查 ──

function checkBudget(budgetLimit: number): { exceeded: boolean; currentCost: number } {
  const currentCost = getTotalCost();
  return {
    exceeded: currentCost > budgetLimit,
    currentCost,
  };
}

// ── 需求分析（基于新的分类体系）──

function analyzeRequirement(requirement: string): {
  classification: TaskClassification;
  crossLayer: ReturnType<typeof detectCrossLayer>;
  pipeline: { design: boolean; plan: boolean; code: boolean; audit: boolean; assemble: boolean };
} {
  const classification = classifyTask(requirement);
  const crossLayer = detectCrossLayer(requirement);

  // 根据分类决定 pipeline
  const needsDesign = classification.layer === 'view' || crossLayer.isCrossLayer;
  const needsCode = true; // 所有任务都需要代码生成
  const needsAudit = classification.complexity !== 'simple';

  const pipeline = {
    design: needsDesign,
    plan: true, // 所有任务都需要结构规划
    code: needsCode,
    audit: needsAudit,
    assemble: true, // 所有任务都需要组装
  };

  return { classification, crossLayer, pipeline };
}

function getDefaultSpecs(requirement: string) {
  return [
    {
      name: 'MainComponent',
      description: requirement,
      props: [],
      children: [],
      states: [],
      events: [],
    },
  ];
}

// ── Agent 主函数 ──────────────────────────────────────

export async function runOrchestrator(
  requirement: string,
  providers: AllProviders,
  options: {
    framework?: string;
    styleMethod?: string;
    darkMode?: boolean;
    skipDeepAnalysis?: boolean;
    /** 跳过需求精炼（已是结构化需求时可跳过） */
    skipRefine?: boolean;
    /** 最大上下文 tokens（弱模型可设 4000-8000） */
    maxContextTokens?: number;
    /** 会话 ID（用于交接追溯） */
    sessionId?: string;
    /** 预算上限（美元），超过自动停止 */
    budgetLimit?: number;
    /** 组件并行度上限 */
    concurrency?: number;
    /** 包管理器 */
    packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
    /** 项目名 */
    projectName?: string;
    /** 是否将组装结果写入磁盘（默认 true） */
    writeToFS?: boolean;
    /** 输出目录（默认 ./output/<projectName>/） */
    outputDir?: string;
  } = {},
): Promise<OrchestratorResult> {
  const {
    framework = 'react',
    styleMethod = 'tailwind',
    darkMode = false,
    skipDeepAnalysis = false,
    skipRefine = false,
    maxContextTokens = 32000,
    sessionId = `session_${Date.now()}`,
    budgetLimit = DEFAULT_BUDGET_LIMIT,
    concurrency = 5,
    packageManager = 'pnpm',
    projectName,
    writeToFS = true,
    outputDir,
  } = options;

  resetCostRecords();
  resetTelemetryLog();

  // ── 初始化会话管理器 ──
  const session = new SessionManager(sessionId, {
    maxTokens: maxContextTokens,
    objective: requirement,
  });

  // ── 断点恢复：检测是否有可恢复的 checkpoint ──
  const checkpointOptions: PipelineCheckpoint['options'] = {
    framework,
    styleMethod,
    darkMode,
    skipDeepAnalysis,
    skipRefine,
    concurrency,
    packageManager,
    projectName,
    writeToFS,
    outputDir,
    budgetLimit,
    maxContextTokens,
  };

  let checkpoint: PipelineCheckpoint;
  const existingCheckpoint = findResumableCheckpoint(requirement);

  if (existingCheckpoint) {
    checkpoint = existingCheckpoint;
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          🔄 检测到断点，恢复执行！                       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  上次完成：${(checkpoint.lastCompletedStep ?? '无').padEnd(43)}  ║`);
    console.log(`║  已花费：$${checkpoint.costSoFar.toFixed(4).padEnd(43)}  ║`);
    console.log(`║  下一步：${(getNextStep(checkpoint) ?? '全部完成').padEnd(43)}  ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  } else {
    checkpoint = createCheckpoint(sessionId, requirement, checkpointOptions);
    saveCheckpoint(checkpoint);
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          🤖 Frontend Agent Orchestrator v5              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  需求：${requirement.slice(0, 46).padEnd(46)}  ║`);
  console.log(`║  框架：${framework.padEnd(46)}  ║`);
  console.log(`║  样式：${styleMethod.padEnd(46)}  ║`);
  console.log(`║  预算：$${budgetLimit.toFixed(2).padEnd(44)}  ║`);
  console.log(`║  会话：${sessionId.slice(0, 46).padEnd(46)}  ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── Step 0: 需求精炼（executor 级，低成本）──
  let effectiveRequirement = requirement;
  let refinedResult: RefinedRequirement | undefined;

  if (isStepCompleted(checkpoint, 'refine')) {
    // 从 checkpoint 恢复
    console.log('═══ Step 0: 需求精炼 ⏩ 已恢复 ═══');
    refinedResult = checkpoint.refined;
    effectiveRequirement = checkpoint.effectiveRequirement ?? requirement;
  } else if (!skipRefine) {
    console.log('═══ Step 0: 需求精炼 ═══');
    refinedResult = await runPromptRefiner(requirement, providers);
    effectiveRequirement = refinedResult.refined;

    session.addDecision({
      what: '需求精炼',
      why: `原始需求 → 精炼需求，提取 ${refinedResult.entities.length} 个实体、${refinedResult.constraints.length} 个约束`,
      alternatives: ['跳过精炼（skipRefine: true）'],
    });
    session.trackTokens(300);

    // 保存 checkpoint
    checkpoint.refined = refinedResult;
    checkpoint.effectiveRequirement = effectiveRequirement;
    checkpoint.lastCompletedStep = 'refine';
    checkpoint.costSoFar = getTotalCost();
    saveCheckpoint(checkpoint);
    console.log('   💾 checkpoint 已保存（refine）');
  }

  const frameworkRouting = resolveFrameworkFromUserInput({
    requirement,
    refinedRequirement: refinedResult,
    explicitFramework: framework,
  });
  const resolvedFramework = frameworkRouting.framework;
  const resolvedGenerator = getCodeGenerator(resolvedFramework);

  console.log('\n═══ Framework 路由 ═══');
  console.log(`   选择框架：${resolvedFramework}`);
  console.log(`   生成器：${resolvedGenerator.displayName}`);
  console.log(`   来源：${frameworkRouting.source}`);
  console.log(`   原因：${frameworkRouting.reason}`);
  if (frameworkRouting.overriddenExplicit && framework !== resolvedFramework) {
    console.log(`   ⚠️  已覆盖显式 framework 参数：${framework} → ${resolvedFramework}`);
  }
  console.log(`   🧾 最终主流程框架：${resolvedFramework}`);

  // ── Step 1: 多维分类（零 LLM 成本）──
  let classification: TaskClassification;
  let crossLayer: {
    isCrossLayer: boolean;
    viewScore: number;
    logicScore: number;
    suggestion?: string;
  };
  let pipeline: {
    design: boolean;
    plan: boolean;
    code: boolean;
    audit: boolean;
    assemble: boolean;
  };

  if (isStepCompleted(checkpoint, 'classify')) {
    // 从 checkpoint 恢复
    console.log('\n═══ Step 1: 需求分类 ⏩ 已恢复 ═══');
    if (!checkpoint.classification || !checkpoint.crossLayer || !checkpoint.pipeline) {
      console.warn('⚠️  Checkpoint 数据不完整，重新执行分类步骤');
      const analyzed = analyzeRequirement(effectiveRequirement);
      classification = analyzed.classification;
      crossLayer = analyzed.crossLayer;
      pipeline = analyzed.pipeline;
    } else {
      classification = checkpoint.classification;
      crossLayer = checkpoint.crossLayer;
      pipeline = checkpoint.pipeline;
    }
  } else {
    console.log('\n═══ Step 1: 需求分类 ═══');
    const analyzed = analyzeRequirement(effectiveRequirement);
    classification = analyzed.classification;
    crossLayer = analyzed.crossLayer;
    pipeline = analyzed.pipeline;

    // 保存 checkpoint
    checkpoint.resolvedFramework = resolvedFramework;
    checkpoint.classification = classification;
    checkpoint.crossLayer = crossLayer;
    checkpoint.pipeline = pipeline;
    checkpoint.lastCompletedStep = 'classify';
    checkpoint.costSoFar = getTotalCost();
    saveCheckpoint(checkpoint);
    console.log('   💾 checkpoint 已保存（classify）');
  }

  console.log(`   层级：${classification.layer}`);
  console.log(`   类型：${classification.category}`);
  console.log(`   复杂度：${classification.complexity}`);
  console.log(`   推荐模型：${classification.recommendedTier}`);
  console.log(`   预估 tokens：${classification.estimatedContextTokens}`);
  console.log(`   分类依据：${classification.reasoning}`);

  if (crossLayer.isCrossLayer) {
    console.log(`   ⚡ 跨层需求！view: ${crossLayer.viewScore}, logic: ${crossLayer.logicScore}`);
    console.log(`   ${crossLayer.suggestion}`);
  }

  if (classification.mayNeedHandoff) {
    console.log(`   ⚠️  预计需要会话交接（弱模型上下文可能不足）`);
  }

  console.log(
    `   Pipeline：${Object.entries(pipeline)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(' → ')}`,
  );

  session.addDecision({
    what: `任务分类为 ${classification.layer}/${classification.category} (${classification.complexity})`,
    why: classification.reasoning,
    alternatives: ['手动指定分类'],
  });
  session.trackTokens(500);

  const result: OrchestratorResult = {
    requirement,
    refinedRequirement: refinedResult,
    classification,
    crossLayer,
    pipeline,
    iterations: checkpoint.iterationsSoFar,
    finalVerdict: 'partial',
    totalCost: checkpoint.costSoFar,
  };

  // 恢复已完成步骤的结果到 result
  if (checkpoint.design) result.design = checkpoint.design;
  if (checkpoint.plan) result.plan = checkpoint.plan;
  if (checkpoint.code) result.code = checkpoint.code;
  if (checkpoint.audit) result.audit = checkpoint.audit;
  if (checkpoint.assembly) result.assembly = checkpoint.assembly;

  // ── Step 2: 检查上下文是否够用 ──
  if (session.predictOverflow(classification.estimatedContextTokens)) {
    console.log('\n⚠️  上下文预估不足！生成交接包...');
    const handoff = session.generateHandoff();
    session.setNextSteps([
      {
        priority: 'high',
        description: '在新会话中继续执行',
        estimatedTokens: classification.estimatedContextTokens,
      },
    ]);
    result.handoff = handoff;
    result.totalCost = getTotalCost();
    checkpoint.costSoFar = getTotalCost();
    saveCheckpoint(checkpoint);
    console.log('   ✅ 交接包已生成，请在新会话中使用');
    console.log('\n' + handoff.openingTemplate);
    return result;
  }

  // ── Step 3: 设计分析 ──
  if (pipeline.design) {
    if (isStepCompleted(checkpoint, 'design')) {
      console.log('\n═══ Step 2: 设计分析 ⏩ 已恢复 ═══');
      console.log(
        `   组件树：${result.design?.componentTree.map((c) => c.name).join(', ') ?? '无'}`,
      );
    } else {
      console.log('\n═══ Step 2: 设计分析 ═══');

      const budget = checkBudget(budgetLimit);
      if (budget.exceeded) {
        console.log(
          `\n⚠️  预算已超限 ($${budget.currentCost.toFixed(4)} > $${budgetLimit})，停止执行`,
        );
        result.totalCost = budget.currentCost;
        return result;
      }

      const handoffCheck = session.shouldHandoff();
      if (handoffCheck.needed && handoffCheck.urgency === 'immediate') {
        result.handoff = session.generateHandoff();
        result.totalCost = getTotalCost();
        return result;
      }

      result.design = await runDesignAnalyzer(effectiveRequirement, providers, {
        framework: resolvedFramework,
        styleSystem: styleMethod,
      });

      session.addCompleted({
        description: `设计分析：${result.design.componentTree.length} 个组件`,
        result: result.design.componentTree.map((c) => c.name).join(', '),
        modelUsed: 'worker',
      });
      session.trackTokens(2000);

      // 保存 checkpoint
      checkpoint.design = result.design;
      checkpoint.lastCompletedStep = 'design';
      checkpoint.costSoFar = getTotalCost();
      saveCheckpoint(checkpoint);
      console.log('   💾 checkpoint 已保存（design）');
    }
  }

  // ── Step 3+4: 项目规划 ⚡ 代码生成（并行 fork-join）──
  //
  // 设计分析完成后，项目规划和代码生成互不依赖，可以同时启动：
  //   fork ─┬── 项目规划 (worker, 1 LLM call)
  //         └── 代码生成 (worker×N 组件, 全并行)
  //   join ──→  审计 → 组装
  //
  // 这样不管多少组件，总耗时 ≈ max(规划, 最慢组件) 而非累加

  if (pipeline.plan || pipeline.code) {
    if (isStepCompleted(checkpoint, 'plan+code')) {
      console.log('\n═══ Step 3+4: 项目规划 ⚡ 代码生成 ⏩ 已恢复 ═══');
      if (result.plan)
        console.log(
          `   规划：${result.plan.structure.projectName} | ${result.plan.structure.directories.length} 目录`,
        );
      if (result.code) console.log(`   代码：${result.code.totalComponents} 个组件`);
    } else {
      const budget = checkBudget(budgetLimit);
      if (budget.exceeded) {
        console.log(
          `\n⚠️  预算已超限 ($${budget.currentCost.toFixed(4)} > $${budgetLimit})，跳过规划+生成`,
        );
        result.totalCost = budget.currentCost;
      } else {
        console.log('\n═══ Step 3+4: 项目规划 ⚡ 代码生成（并行）═══');

        const specs = result.design?.componentTree ?? getDefaultSpecs(effectiveRequirement);

        // ── fork: 同时启动规划和代码生成 ──

        const parallelTasks: Array<Promise<void>> = [];

        // Task A: 项目规划
        if (pipeline.plan && result.design) {
          console.log(`   🏗️  fork → 项目规划`);
          parallelTasks.push(
            runProjectPlanner(effectiveRequirement, result.design, providers, {
              framework: resolvedFramework,
              styleMethod,
              packageManager,
              darkMode,
              projectName,
            }).then((planResult) => {
              result.plan = planResult;
              session.addCompleted({
                description: `项目规划：${planResult.structure.directories.length} 目录, ${planResult.structure.files.length} 文件`,
                result: `框架: ${planResult.structure.framework}, 项目名: ${planResult.structure.projectName}`,
                modelUsed: 'worker',
              });
              session.trackTokens(1500);
            }),
          );
        }

        // Task B: 代码生成（内部已经并行化所有组件）
        if (pipeline.code) {
          console.log(`   🧩  fork → 代码生成 (${specs.length} 个组件全并行)`);
          parallelTasks.push(
            runCodeProducer(specs, providers, {
              framework: resolvedFramework,
              styleMethod,
              darkMode,
              concurrency: Math.min(specs.length, concurrency), // 并行但有上限，防 OOM
            }).then((codeResult) => {
              result.code = codeResult;
              result.iterations = 1;
              session.addCompleted({
                description: `代码生成：${codeResult.totalComponents} 个组件`,
                result: `自检通过: ${codeResult.allPassed}`,
                modelUsed: 'worker/executor',
              });
              session.trackTokens(3000);

              for (const comp of codeResult.components) {
                for (const artifact of comp.artifacts) {
                  session.addCodeArtifact(
                    artifact.fileName,
                    `${comp.componentName} - ${comp.generatorId} - ${comp.modelTiersUsed.join(',')}`,
                  );
                }
              }
            }),
          );
        }

        // ── join: 等待规划和代码生成全部完成 ──
        await Promise.all(parallelTasks);
        console.log('\n   ✅ 规划 + 代码生成 并行完成');

        // 保存 checkpoint
        checkpoint.plan = result.plan;
        checkpoint.code = result.code;
        checkpoint.lastCompletedStep = 'plan+code';
        checkpoint.costSoFar = getTotalCost();
        checkpoint.iterationsSoFar = result.iterations;
        saveCheckpoint(checkpoint);
        console.log('   💾 checkpoint 已保存（plan+code）');
      }
    }
  }

  // ── Step 5: 代码审计（审计循环，最多再修一轮）──
  if (pipeline.audit && result.code && result.code.components.length > 0) {
    if (isStepCompleted(checkpoint, 'audit')) {
      console.log('\n═══ Step 5: 代码审计 ⏩ 已恢复 ═══');
      console.log(`   评分：${result.audit?.overallScore}/10`);
    } else {
      let iteration = checkpoint.auditIteration ?? 0;
      const maxAuditIterations = MAX_ITERATIONS;

      while (iteration < maxAuditIterations) {
        iteration++;
        result.iterations = iteration;

        const budget = checkBudget(budgetLimit);
        if (budget.exceeded) {
          console.log(`\n⚠️  预算已超限，跳过审计`);
          result.finalVerdict = result.code.allPassed ? 'passed' : 'partial';
          break;
        }

        console.log(`\n═══ Step 5: 代码审计 (第 ${iteration}/${maxAuditIterations} 轮) ═══`);

        const allCode = result.code.components
          .flatMap((component) =>
            component.artifacts.map(
              (artifact) => `// ===== ${artifact.fileName} =====\n${artifact.content}`,
            ),
          )
          .join('\n\n');

        result.audit = await runCodeAuditor(allCode, providers, {
          framework: resolvedFramework,
          skipDeepAnalysis: skipDeepAnalysis || iteration > 1,
          qualityThreshold: QUALITY_THRESHOLD,
        });

        session.trackTokens(2000);

        if (result.audit.passed) {
          result.finalVerdict = 'passed';
          session.addCompleted({
            description: `审计通过`,
            result: `评分: ${result.audit.overallScore}/10`,
            modelUsed: 'reasoner/executor',
          });
          console.log(`\n✅ 质量达标！评分: ${result.audit.overallScore}/10`);
          break;
        }

        if (iteration < maxAuditIterations) {
          session.addBlocker(
            `审计不达标 (${result.audit.overallScore}/${QUALITY_THRESHOLD})，需要第 ${iteration + 1} 轮迭代`,
          );
          console.log(
            `\n⚠️  质量不达标 (${result.audit.overallScore}/${QUALITY_THRESHOLD})，重新生成...`,
          );

          // 重新生成代码
          const specs = result.design?.componentTree ?? getDefaultSpecs(effectiveRequirement);

          result.code = await runCodeProducer(specs, providers, {
            framework: resolvedFramework,
            styleMethod,
            darkMode,
            concurrency: Math.min(specs.length, concurrency),
          });

          for (const comp of result.code.components) {
            for (const artifact of comp.artifacts) {
              session.addCodeArtifact(
                artifact.fileName,
                `${comp.componentName} - ${comp.generatorId} - ${comp.modelTiersUsed.join(',')}`,
              );
            }
          }

          // 每轮审计后保存 checkpoint（审计循环中间态）
          checkpoint.code = result.code;
          checkpoint.audit = result.audit;
          checkpoint.auditIteration = iteration;
          checkpoint.costSoFar = getTotalCost();
          checkpoint.iterationsSoFar = result.iterations;
          saveCheckpoint(checkpoint);
          console.log(`   💾 checkpoint 已保存（audit 第 ${iteration} 轮）`);
        } else {
          result.finalVerdict = 'failed';
          console.log(`\n❌ 达到最大迭代次数，最终评分: ${result.audit.overallScore}/10`);
        }
      }

      // 审计完成后保存 checkpoint
      checkpoint.audit = result.audit;
      checkpoint.auditIteration = undefined;
      checkpoint.lastCompletedStep = 'audit';
      checkpoint.costSoFar = getTotalCost();
      checkpoint.iterationsSoFar = result.iterations;
      saveCheckpoint(checkpoint);
      console.log('   💾 checkpoint 已保存（audit 完成）');
    }
  } else if (result.code) {
    result.finalVerdict = result.code.allPassed ? 'passed' : 'partial';
    result.iterations = result.iterations || 1;
  }

  // ── Step 6: 代码组装（即使上下文溢出也要执行，这是最后一步）──
  if (pipeline.assemble && result.code && result.plan) {
    if (isStepCompleted(checkpoint, 'assemble')) {
      console.log('\n═══ Step 6: 代码组装 ⏩ 已恢复 ═══');
      console.log(`   文件：${result.assembly?.totalFiles} 个`);
    } else {
      console.log('\n═══ Step 6: 代码组装 ═══');

      // 自动推导输出目录
      const resolvedOutputDir =
        outputDir ??
        path.resolve(
          process.cwd(),
          'output',
          result.plan.structure.projectName || `frontend-agent-${Date.now()}`,
        );

      result.assembly = await runCodeAssembler(result.plan.structure, result.code, providers, {
        framework: resolvedFramework,
        styleMethod,
        darkMode,
        writeToFS,
        outputDir: resolvedOutputDir,
        pageTitle: result.plan.structure.projectName,
      });

      session.addCompleted({
        description: `代码组装：${result.assembly.totalFiles} 个文件`,
        result: `项目: ${result.assembly.projectName}, 入口: ${result.assembly.entryPoint}`,
        modelUsed: 'worker',
      });
      session.trackTokens(2000);

      // 记录组装产出
      for (const file of result.assembly.files) {
        session.addCodeArtifact(file.filePath, `assembled (${file.source})`);
      }

      // 保存 checkpoint
      checkpoint.assembly = result.assembly;
      checkpoint.lastCompletedStep = 'assemble';
      checkpoint.costSoFar = getTotalCost();
      saveCheckpoint(checkpoint);
      console.log('   💾 checkpoint 已保存（assemble）');
    }
  }
  // ── Step 7: 最终审计（如果组装了完整项目）──
  if (pipeline.audit && result.assembly) {
    console.log('\n═══ Step 7: 最终审计 ═══');

    const allCode = result.assembly.files
      .map((file) => `// ===== ${file.filePath} =====\n${file.content}`)
      .join('\n\n');

    const finalAudit = await runCodeAuditor(allCode, providers, {
      framework: resolvedFramework,
      skipDeepAnalysis: true, // 最终审计不需要深分析，主要检查组装后是否有明显问题
      qualityThreshold: QUALITY_THRESHOLD,
    });

    session.trackTokens(2000);

    if (finalAudit.passed) {
      result.finalVerdict = 'passed';
      session.addCompleted({
        description: `最终审计通过`,
        result: `评分: ${finalAudit.overallScore}/10`,
        modelUsed: 'reasoner/executor',
      });
      console.log(`\n✅ 最终质量  达标！评分: ${finalAudit.overallScore}/10`);
    } else {
      if (result.finalVerdict !== 'failed') {
        result.finalVerdict = 'partial';
      }
      session.addBlocker(`最终审计不达标 (${finalAudit.overallScore}/${QUALITY_THRESHOLD})`);
      console.log(`\n⚠️  最终质量不达标 (${finalAudit.overallScore}/${QUALITY_THRESHOLD})`);
    }
  }

  // ── 成本报告 ──
  printCostReport();
  result.totalCost = getTotalCost();

  // ── 上下文使用报告 ──
  const usage = session.getContextUsage();
  console.log(
    `📊 上下文使用：${usage.currentTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`,
  );
  console.log(`💰 总成本：$${result.totalCost.toFixed(6)}\n`);

  // ── 最终交付物总结 ──
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          📦 交付物总结                                   ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  if (refinedResult) {
    console.log(`║  精炼：${refinedResult.refined.slice(0, 46)}`);
  }
  console.log(
    `║  分类：${classification.layer}/${classification.category} (${classification.complexity})`,
  );
  if (result.design) {
    console.log(`║  组件：${result.design.componentTree.length} 个`);
  }
  if (result.plan) {
    console.log(
      `║  规划：${result.plan.structure.projectName} | ${result.plan.structure.directories.length} 目录 | ${result.plan.structure.files.length} 文件`,
    );
  }
  if (result.code) {
    console.log(
      `║  代码：${result.code.components.flatMap((component) => component.artifacts.map((artifact) => artifact.fileName)).join(', ')}`,
    );
  }
  if (result.audit) {
    console.log(`║  审计：${result.audit.overallScore}/10`);
  }
  if (result.assembly) {
    console.log(`║  组装：${result.assembly.totalFiles} 文件 | ${result.assembly.entryPoint}`);
    console.log(`║  运行：${result.assembly.installCommand} && ${result.assembly.devCommand}`);
    if (result.assembly.writtenToDisk) {
      console.log(`║  输出：${result.assembly.outputDir}`);
    } else {
      console.log(`║  ⚠️  未写入磁盘（writeToFS: false）`);
    }
  }
  console.log(
    `║  结果：${result.finalVerdict === 'passed' ? '✅ 通过' : result.finalVerdict === 'failed' ? '❌ 不通过' : '⚠️ 部分完成'}`,
  );
  console.log(`║  轮次：${result.iterations}`);
  console.log(`║  成本：$${result.totalCost.toFixed(6)}`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── 如果未写磁盘且有代码产出，打印到控制台（不能生成完就丢了）──
  if (result.assembly && !result.assembly.writtenToDisk) {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          📄 生成文件内容（未写入磁盘）                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    for (const file of result.assembly.files) {
      console.log(`── ${file.filePath} [${file.source}] ──`);
      console.log(file.content);
      console.log('');
    }
  } else if (!result.assembly && result.code) {
    // 组装失败但有代码产出，至少打印原始组件代码
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          📄 原始组件代码（组装未完成）                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    for (const component of result.code.components) {
      for (const artifact of component.artifacts) {
        console.log(`── ${component.componentName}/${artifact.fileName} ──`);
        console.log(artifact.content);
        console.log('');
      }
    }
  }
  try {
    const snapshotPath = session.saveSnapshot();
    console.log(`💾 会话快照已保存：${snapshotPath}`);
  } catch {
    // 静默失败，不影响主流程
  }

  // ── Pipeline 成功完成，清理 checkpoint ──
  deleteCheckpoint(checkpoint.sessionId);
  console.log('🧹 checkpoint 已清理（pipeline 完成）');

  return result;
}
