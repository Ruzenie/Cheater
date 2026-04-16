/**
 * design-analyzer.ts — 设计分析 Agent（v3 — 宽松解析 + 并行 + Telemetry）
 *
 * 优化点：
 *   1. 使用 generateText + 手动 JSON 解析 + zod safeParse（兼容第三方模型）
 *   2. 响应式策略 + 状态设计 Promise.all 并行执行
 *   3. 集成 experimental_telemetry 追踪每步耗时和 token
 *
 * 模型策略：使用 worker 级别即可（设计分析不需要强推理）
 */

import { streamText } from 'ai';
import { z } from 'zod';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import {
  ComponentSpecSchema,
} from '../tools/design/index.js';

// ── 输出 Schema ──────────────────────────────────────

const ResponsiveStrategySchema = z.object({
  approach: z.string().describe('响应式方案名称，如 mobile-first'),
  breakpoints: z.record(z.number()).describe('断点名到像素值的映射'),
  notes: z.array(z.string()).describe('注意事项').optional().default([]),
});

const StateDesignSchema = z.object({
  localStates: z.array(z.object({
    component: z.string(),
    states: z.array(z.string()),
  })).describe('各组件的本地状态').optional().default([]),
  sharedStates: z.array(z.string()).describe('跨组件共享状态').optional().default([]),
  recommendation: z.string().describe('推荐的状态管理方案'),
});

const DesignOutputSchema = z.object({
  componentTree: z.array(ComponentSpecSchema),
  responsiveStrategy: ResponsiveStrategySchema,
  stateDesign: StateDesignSchema,
});

export type DesignOutput = z.infer<typeof DesignOutputSchema>;

// ── Telemetry 配置 ──

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

/**
 * 将嵌套对象格式的组件树转为数组格式
 * 模型可能返回 { root: {...}, NavbarHeader: {...} } 而不是 [{...}, {...}]
 */
function normalizeComponentTree(raw: any): any[] {
  // 如果已经是数组，直接返回
  if (Array.isArray(raw)) return raw;

  // 如果是对象（key = 组件名），转为数组
  if (typeof raw === 'object' && raw !== null) {
    return Object.values(raw).filter(
      (v: any) => typeof v === 'object' && v !== null && v.name,
    );
  }

  return [];
}

// ── Agent 主函数 ──────────────────────────────────────

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
- 目标是每个组件独立有意义、有实际 HTML/CSS/JS 内容，而不是抽象层`,
    prompt: `请将以下前端需求拆解为组件树（JSON 格式）：\n\n${requirement}`,
    temperature: 0.3,
    experimental_telemetry: telemetryConfig('design-analyzer:decompose'),
  });
  const decomposeText = await consumeTextStream(decomposeStream.textStream, { prefix: '      [decompose] ', echo: false });

  // 宽松解析：兼容模型返回的各种格式偏差
  let parsedComponents: z.infer<typeof ComponentSpecSchema>[];
  try {
    const rawJson = safeParseJson(decomposeText);
    // 提取组件列表：支持 { components: [...] } 或 { componentTree: {...} } 等
    const rawList = rawJson.components ?? rawJson.componentTree ?? rawJson;
    const normalized = normalizeComponentTree(rawList);

    // 用 safeParse 做宽松验证，跳过不合格的组件
    parsedComponents = normalized
      .map((c: any) => ComponentSpecSchema.safeParse(c))
      .filter((r: any) => r.success)
      .map((r: any) => r.data);

    if (parsedComponents.length === 0) {
      throw new Error('没有解析到有效组件');
    }

    // 组件数量安全上限：过多组件会导致后续代码生成 OOM
    const MAX_COMPONENTS = 4;
    if (parsedComponents.length > MAX_COMPONENTS) {
      console.warn(`   ⚠️  组件数过多 (${parsedComponents.length})，截断到 ${MAX_COMPONENTS} 个`);
      parsedComponents = parsedComponents.slice(0, MAX_COMPONENTS);
    }
  } catch (e: any) {
    console.warn(`   ⚠️  组件树解析失败 (${e.message})，使用 fallback`);
    parsedComponents = [{
      name: 'MainComponent',
      description: requirement,
      props: [],
      children: [],
      states: [],
      events: [],
    }];
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
    responsiveStrategy = parsed.success ? parsed.data : {
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
    const rawState = safeParseJson(stateText);
    const parsed = StateDesignSchema.safeParse(rawState);
    stateDesign = parsed.success ? parsed.data : {
      localStates: [],
      sharedStates: [],
      recommendation: rawState.recommendation ?? stateText.slice(0, 200),
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
