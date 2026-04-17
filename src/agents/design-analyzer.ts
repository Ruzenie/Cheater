/**
 * design-analyzer.ts — 设计分析 Agent（v3 — 宽松解析 + 并行 + Telemetry）
 *
 * 本文件负责将精炼后的需求分解为：
 *   1. 组件树（ComponentSpec[]）— 每个组件的名称、职责、props、states、events
 *   2. 响应式策略 — 移动优先/桌面优先、断点定义
 *   3. 状态管理设计 — 本地状态、共享状态、推荐方案
 *
 * 在流水线中的位置：
 *   Step 2: orchestrator 在需求分类（Step 1）之后调用本模块
 *   输出的组件树传递给 code-producer（Step 4）进行代码生成
 *   输出的完整 DesignOutput 传递给 project-planner（Step 3）进行项目规划
 *
 * 优化点：
 *   1. 使用 streamText + 手动 JSON 解析 + zod safeParse（兼容第三方模型的非标输出）
 *   2. 响应式策略 + 状态设计 Promise.all 并行执行（与组件树拆解串行，因为后两者依赖组件列表）
 *   3. 集成 experimental_telemetry 追踪每步耗时和 token 消耗
 *
 * 模型策略：
 *   - 组件树拆解 → worker 级别（需要理解需求和框架约定）
 *   - 响应式策略 → worker 级别（需要 UI 设计知识）
 *   - 状态管理 → executor 级别（相对简单的分析任务）
 *
 * 容错策略：
 *   - 组件树解析失败时回退到单个 MainComponent
 *   - 响应式策略解析失败时使用 mobile-first 默认值
 *   - 状态设计解析失败时返回空状态 + 提示手动分析
 *   - 组件数量超过 MAX_COMPONENTS（4）时自动截断，防止后续代码生成 OOM
 *
 * 输入类型：
 *   @param requirement - 精炼后的需求文本
 *
 * 输出类型：
 *   @returns DesignOutput - 包含组件树、响应式策略、状态管理设计
 */

import { streamText } from 'ai';
import { z } from 'zod';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import { ComponentSpecSchema } from '../tools/design/index.js';

// ── 输出 Schema（使用 Zod 定义，用于宽松解析 LLM 输出）──────────

/** 响应式策略的 Zod 验证模式 */

const ResponsiveStrategySchema = z.object({
  approach: z.string().describe('响应式方案名称，如 mobile-first'),
  breakpoints: z.record(z.number()).describe('断点名到像素值的映射'),
  notes: z.array(z.string()).describe('注意事项').optional().default([]),
});

/** 状态管理设计的 Zod 验证模式 */
const StateDesignSchema = z.object({
  localStates: z
    .array(
      z.object({
        component: z.string(),
        states: z.array(z.string()),
      }),
    )
    .describe('各组件的本地状态')
    .optional()
    .default([]),
  sharedStates: z.array(z.string()).describe('跨组件共享状态').optional().default([]),
  recommendation: z.string().describe('推荐的状态管理方案'),
});

/** 设计分析完整输出的 Zod 验证模式 */
const DesignOutputSchema = z.object({
  componentTree: z.array(ComponentSpecSchema),
  responsiveStrategy: ResponsiveStrategySchema,
  stateDesign: StateDesignSchema,
});

/** 设计分析的输出类型（从 Zod Schema 推导） */
export type DesignOutput = z.infer<typeof DesignOutputSchema>;

// ── Telemetry 配置 ──────────────────────────────────

/**
 * 构建 telemetry 配置对象。
 *
 * @param functionId - 调用标识符，如 `design-analyzer:decompose`
 * @returns AI SDK 的 experimental_telemetry 配置
 */
function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

/**
 * 将嵌套对象格式的组件树转为数组格式。
 * 某些模型可能返回 `{ root: {...}, NavbarHeader: {...} }` 而不是标准的 `[{...}, {...}]`，
 * 本函数将两种格式统一为数组。
 *
 * @param raw - LLM 返回的原始组件树数据（可能是数组或对象）
 * @returns 标准化的组件对象数组
 */
function normalizeComponentTree(raw: unknown): Record<string, unknown>[] {
  // 如果已经是数组，直接返回
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];

  // 如果是对象（key = 组件名），转为数组
  if (typeof raw === 'object' && raw !== null) {
    return (Object.values(raw) as Record<string, unknown>[]).filter(
      (v) => typeof v === 'object' && v !== null && 'name' in v,
    );
  }

  return [];
}

// ── Agent 主函数 ──────────────────────────────────────

/**
 * 设计分析 Agent 主函数 — 将需求分解为组件树 + 响应式策略 + 状态设计。
 *
 * 执行流程：
 *   Step 1: 组件树拆解（串行，worker 模型，后续步骤依赖其结果）
 *   Step 2+3: 响应式策略 + 状态设计（并行，分别使用 worker 和 executor 模型）
 *
 * @param requirement - 精炼后的需求文本
 * @param providers   - LLM 提供商配置
 * @param options     - 框架和样式系统配置
 * @returns 设计分析完整输出
 */
export async function runDesignAnalyzer(
  requirement: string,
  providers: AllProviders,
  options: {
    framework?: string;
    styleSystem?: string;
  } = {},
): Promise<DesignOutput> {
  const { framework = 'react', styleSystem = 'tailwind' } = options;
  const model = getWrappedModel('worker', providers);

  console.log('\n🎨 [Design Agent] 开始分析需求...');
  console.log(`   需求：${requirement.slice(0, 80)}${requirement.length > 80 ? '...' : ''}`);

  // ══ Step 1: 拆解组件树（必须先完成，后续步骤依赖）══

  console.log('   📐 Step 1/3: 拆解组件树...');
  const decomposeStream = streamText({
    model,
    system: `你是一个资深前端架构师，擅长将需求拆解为组件树。
框架：${framework}，样式：${styleSystem}。

你必须输出合法的 JSON，格式如下：
{
  "components": [
    {
      "name": "组件名(PascalCase)",
      "description": "组件职责描述",
      "props": [{"name": "propName", "type": "string", "required": false, "description": "说明"}],
      "children": ["子组件名"],
      "states": [{"name": "stateName", "type": "boolean", "description": "说明"}],
      "events": [{"name": "onClick", "payload": "void", "description": "说明"}]
    }
  ]
}

注意：
- 输出必须是一个包含 "components" 数组的 JSON 对象
- props、children、states、events 都是数组（即使为空也要写 []）
- 不要输出任何 JSON 以外的内容
- 每个组件必须有独立、完整的功能，不能是空壳/包装器/TODO
- 不要创建 "Provider"、"Container"、"Wrapper" 等纯包装组件
- 不要拆出功能重叠的组件（如同时有 ThemeProvider 和 ThemeToggle，应合并为一个 ThemeToggle）
- 把紧密关联的 UI 元素合并为一个组件（如登录表单的输入框+按钮+验证=LoginForm，不要拆成 FormInput+SubmitButton+FormActions）
- 目标是每个组件独立有意义、有实际 HTML/CSS/JS 内容，而不是抽象层

⚠ 严禁创建"整页组件"（即组件本身就是一个完整页面）：
- 禁止创建名为 XxxPage、PageLayout、FullPage 等组件，这些组件会和其他子组件功能完全重叠
- 每个组件只负责页面的一个独立部分（如 LoginForm 只负责表单，ThemeToggle 只负责主题切换），由 assembler 负责将它们组装成完整页面
- 如果需求是"做一个登录页面"，正确做法是拆出 ThemeToggle、LoginForm、SocialLogin 等功能组件，而不是在这些组件之外再拆出一个包含所有功能的 LoginPage 组件
- 页面级布局（header、footer、页面结构）由框架的组装步骤自动处理，组件不需要关心

⚠ 组件间不能有功能包含关系：
- 如果组件 A 的 description 涵盖了组件 B 和 C 的所有功能，那么 A 就不应该存在
- 每个组件的职责必须是互斥的，不能出现"一个组件是另一个组件的超集"的情况`,
    prompt: `请将以下前端需求拆解为组件树（JSON 格式）：\n\n${requirement}`,
    temperature: 0.3,
    experimental_telemetry: telemetryConfig('design-analyzer:decompose'),
  });
  const decomposeText = await consumeTextStream(decomposeStream.textStream, {
    prefix: '      [decompose] ',
    echo: false,
  });

  // ── 宽松解析组件树 ──
  // 兼容模型返回的各种格式偏差：
  //   - { components: [...] }（标准）
  //   - { componentTree: {...} }（对象格式）
  //   - 直接返回数组
  // 用 zod safeParse 做宽松验证，跳过不合格的组件而非全部失败
  let parsedComponents: z.infer<typeof ComponentSpecSchema>[];
  try {
    const rawJson = safeParseJson(decomposeText) as Record<string, unknown>;
    // 提取组件列表：支持 { components: [...] } 或 { componentTree: {...} } 等
    const rawList = rawJson.components ?? rawJson.componentTree ?? rawJson;
    const normalized = normalizeComponentTree(rawList);

    // 用 safeParse 做宽松验证，跳过不合格的组件
    parsedComponents = normalized
      .map((c) => ComponentSpecSchema.safeParse(c))
      .filter((r) => r.success)
      .map((r) => r.data);

    if (parsedComponents.length === 0) {
      throw new Error('没有解析到有效组件');
    }

    // 组件数量安全上限：过多组件会导致后续代码生成 OOM
    const MAX_COMPONENTS = 4;
    if (parsedComponents.length > MAX_COMPONENTS) {
      console.warn(`   ⚠️  组件数过多 (${parsedComponents.length})，截断到 ${MAX_COMPONENTS} 个`);
      parsedComponents = parsedComponents.slice(0, MAX_COMPONENTS);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`   ⚠️  组件树解析失败 (${message})，使用 fallback`);
    parsedComponents = [
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

  console.log(`   ✅ 拆解完成，共 ${parsedComponents.length} 个组件`);

  // ══ Step 2 + 3: 响应式策略 + 状态设计（⚡ 并行执行）══

  console.log('   📱🧠 Step 2+3: 响应式策略 & 状态设计（并行）...');

  const rootComponent = parsedComponents[0];

  // 启动两个流（streamText 立即返回，实际请求在消费时发起）
  const responsiveStream = streamText({
    model,
    system: `你是一个前端响应式设计专家。根据组件结构输出响应式策略。

你必须输出合法的 JSON，格式如下：
{
  "approach": "mobile-first",
  "breakpoints": {"mobile": 375, "tablet": 768, "desktop": 1024},
  "notes": ["注意事项1", "注意事项2"]
}

不要输出任何 JSON 以外的内容。`,
    prompt: `为 ${rootComponent?.name ?? '根组件'} 设计响应式策略。
组件描述：${rootComponent?.description ?? requirement}
子组件：${parsedComponents.map((c) => c.name).join(', ')}`,
    temperature: 0.2,
    experimental_telemetry: telemetryConfig('design-analyzer:responsive'),
  });

  const stateStream = streamText({
    model: getWrappedModel('executor', providers),
    system: `你是一个前端状态管理专家。分析组件树的状态管理需求。

你必须输出合法的 JSON，格式如下：
{
  "localStates": [{"component": "组件名", "states": ["状态1", "状态2"]}],
  "sharedStates": ["共享状态名"],
  "recommendation": "推荐方案的简短说明"
}

不要输出任何 JSON 以外的内容。`,
    prompt: `分析以下组件树的状态管理需求：

组件列表：${parsedComponents.map((c) => `${c.name}: ${c.description}`).join('\n')}`,
    temperature: 0.2,
    experimental_telemetry: telemetryConfig('design-analyzer:state'),
  });

  // 并行等待两个流完成
  const [responsiveText, stateText] = await Promise.all([
    consumeTextStream(responsiveStream.textStream, { prefix: '      [responsive] ', echo: false }),
    consumeTextStream(stateStream.textStream, { prefix: '      [state] ', echo: false }),
  ]);

  // 宽松解析响应式策略
  let responsiveStrategy: z.infer<typeof ResponsiveStrategySchema>;
  try {
    const rawResponsive = safeParseJson(responsiveText);
    const parsed = ResponsiveStrategySchema.safeParse(rawResponsive);
    responsiveStrategy = parsed.success
      ? parsed.data
      : {
          approach: 'mobile-first',
          breakpoints: { mobile: 375, tablet: 768, desktop: 1024 },
          notes: [responsiveText.slice(0, 200)],
        };
  } catch {
    responsiveStrategy = {
      approach: 'mobile-first',
      breakpoints: { mobile: 375, tablet: 768, desktop: 1024 },
      notes: ['解析失败，使用默认值'],
    };
  }

  // 宽松解析状态设计
  let stateDesign: z.infer<typeof StateDesignSchema>;
  try {
    const rawState = safeParseJson(stateText) as Record<string, unknown>;
    const parsed = StateDesignSchema.safeParse(rawState);
    stateDesign = parsed.success
      ? parsed.data
      : {
          localStates: [],
          sharedStates: [],
          recommendation:
            (typeof rawState.recommendation === 'string'
              ? rawState.recommendation
              : undefined) ?? stateText.slice(0, 200),
        };
  } catch {
    stateDesign = {
      localStates: [],
      sharedStates: [],
      recommendation: '解析失败，请手动分析',
    };
  }

  console.log('   ✅ 响应式策略就绪');
  console.log('   ✅ 状态设计完成');
  console.log(`\n🎨 [Design Agent] 分析完成！共 ${parsedComponents.length} 个组件\n`);

  return {
    componentTree: parsedComponents,
    responsiveStrategy,
    stateDesign,
  };
}
