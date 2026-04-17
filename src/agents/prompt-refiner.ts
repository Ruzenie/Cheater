/**
 * prompt-refiner.ts — 需求精炼 Agent
 *
 * 用一个便宜的小模型将用户的自然语言需求转化为：
 *   1. 结构化、注意力集中的技术描述
 *   2. 提取关键实体（组件、交互、样式）
 *   3. 检测隐含约束（无障碍、响应式、性能）
 *   4. 建议技术栈
 *
 * 在流水线中的位置：
 *   Step 0: 作为流水线的第一步，由 orchestrator 调用
 *   将用户的模糊口语化需求转化为精确的技术描述，供后续所有 Agent 使用
 *   可通过 skipRefine 选项跳过（当输入已是结构化需求时）
 *
 * 模型策略：
 *   使用 executor 级别（文本理解和重组，不需要强推理，成本低）
 *
 * 容错策略：
 *   - Zod safeParse 宽松验证：部分字段可用就用
 *   - JSON 解析失败时，将 LLM 纯文本输出作为 refined
 *   - 最坏情况下直接返回原始需求
 *
 * 输入类型：
 *   @param requirement - 用户原始的自然语言需求描述
 *
 * 输出类型：
 *   @returns RefinedRequirement - 包含精炼需求、实体列表、约束列表、建议技术栈
 */

import { streamText } from 'ai';
import { z } from 'zod';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';

// ── 输出类型 ──────────────────────────────────────────

/** 实体的 Zod 验证模式（type + value 结构） */
const EntitySchema = z.object({
  type: z.string().describe('实体类型，如 component, interaction, style, data, layout'),
  value: z.string().describe('实体值'),
});

/** 精炼结果的 Zod 验证模式 */
const RefinedRequirementSchema = z.object({
  refined: z.string().describe('精炼后的核心需求描述'),
  entities: z.array(EntitySchema).describe('提取出的关键实体').optional().default([]),
  constraints: z.array(z.string()).describe('检测到的隐含约束').optional().default([]),
  suggestedStack: z
    .object({
      framework: z.string().optional(),
      styling: z.string().optional(),
    })
    .optional(),
});

/**
 * 需求精炼的输出接口。
 * 比 Zod Schema 多一个 original 字段（保留原始需求备查）。
 */
export interface RefinedRequirement {
  /** 精炼后的核心需求描述（去除口语化、补全技术细节） */
  refined: string;
  /** 提取出的关键实体（组件名、交互类型、样式要求等） */
  entities: { type: string; value: string }[];
  /** 检测到的隐含约束（无障碍、性能、响应式等） */
  constraints: string[];
  /** 建议的技术栈（如果需求中有暗示） */
  suggestedStack?: { framework?: string; styling?: string };
  /** 原始需求（保留备查） */
  original: string;
}

// ── Agent 主函数 ──────────────────────────────────────

/**
 * 需求精炼 Agent 主函数 — 将模糊的自然语言需求转化为结构化技术描述。
 *
 * 执行流程：
 *   1. 用 executor 模型流式生成精炼结果（JSON 格式）
 *   2. 消费流式输出，获取完整文本
 *   3. 宽松解析 JSON：Zod safeParse → 部分可用 → 纯文本兜底 → 原始需求兜底
 *
 * @param requirement - 用户原始的自然语言需求
 * @param providers   - LLM 提供商配置
 * @returns 精炼后的需求结构
 */
export async function runPromptRefiner(
  requirement: string,
  providers: AllProviders,
): Promise<RefinedRequirement> {
  const model = getWrappedModel('executor', providers);

  console.log('\n🔍 [Prompt Refiner] 精炼需求...');
  console.log(`   原始：${requirement.slice(0, 80)}${requirement.length > 80 ? '...' : ''}`);

  const stream = streamText({
    model,
    system: `你是一个需求分析专家，擅长将模糊的自然语言需求转化为精确的技术描述。

你的任务是：
1. 将用户的口语化描述转化为清晰、技术化的需求文档
2. 提取关键实体（组件、交互方式、样式要求、数据结构等）
3. 发现隐含约束（响应式适配、无障碍要求、性能要求、浏览器兼容等）
4. 如果需求中暗示了技术栈偏好，提取出来

输出规则：
- refined：用精确的技术语言重新描述需求，去除语气词和冗余，补全技术细节
- entities：每个实体是 { type, value }，type 包括 component/interaction/style/data/layout/animation
- constraints：列出用户可能没明说但应该考虑的约束
- suggestedStack：仅在需求明确暗示时才填（如提到"Vue"就建议 framework: "vue"）

你必须输出合法的 JSON，格式如下：
{
  "refined": "精炼后的需求描述",
  "entities": [{"type": "component", "value": "导航栏"}],
  "constraints": ["需要响应式适配"],
  "suggestedStack": {"framework": "react"}
}

不要输出任何 JSON 以外的内容。`,
    prompt: requirement,
    temperature: 0.2,
    maxOutputTokens: 3000,
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'prompt-refiner',
      integrations: [frontendAgentTelemetry()],
    },
  });

  // 消费流式输出并保留完整文本
  const resultText = await consumeTextStream(stream.textStream, { prefix: '   ↳ ', echo: false });

  // ── 三级宽松解析策略 ──
  // 1. Zod safeParse 完全成功 → 直接使用
  // 2. safeParse 失败但部分字段可用 → 逐字段提取
  // 3. JSON 解析完全失败 → 用纯文本作为 refined，或回退到原始需求
  let parsed: RefinedRequirement;
  try {
    const rawJson = safeParseJson(resultText) as Record<string, unknown>;
    const validated = RefinedRequirementSchema.safeParse(rawJson);

    if (validated.success) {
      parsed = { ...validated.data, original: requirement };
    } else {
      // 部分字段可用就用
      parsed = {
        refined: (typeof rawJson.refined === 'string' ? rawJson.refined : undefined) ?? requirement,
        entities: Array.isArray(rawJson.entities)
          ? (rawJson.entities as Array<{ type: string; value: string }>)
          : [],
        constraints: Array.isArray(rawJson.constraints) ? (rawJson.constraints as string[]) : [],
        suggestedStack: rawJson.suggestedStack as Record<string, string> | undefined,
        original: requirement,
      };
    }
  } catch {
    // JSON 解析失败，用模型的纯文本输出作为 refined
    console.warn('   ⚠️  精炼结果解析失败，使用原始需求');
    parsed = {
      refined: resultText.length > 0 && resultText.length < 2000 ? resultText : requirement,
      entities: [],
      constraints: [],
      original: requirement,
    };
  }

  console.log(`   ✅ 精炼完成`);
  console.log(
    `   📝 精炼：${parsed.refined.slice(0, 80)}${parsed.refined.length > 80 ? '...' : ''}`,
  );

  if (parsed.entities.length > 0) {
    console.log(`   🏷️  实体：${parsed.entities.map((e) => `[${e.type}] ${e.value}`).join('、')}`);
  }
  if (parsed.constraints.length > 0) {
    console.log(`   ⚡ 约束：${parsed.constraints.join('、')}`);
  }
  if (parsed.suggestedStack) {
    const stack = parsed.suggestedStack;
    const parts = [];
    if (stack.framework) parts.push(`框架: ${stack.framework}`);
    if (stack.styling) parts.push(`样式: ${stack.styling}`);
    if (parts.length > 0) console.log(`   🛠️  建议：${parts.join('、')}`);
  }

  return parsed;
}
