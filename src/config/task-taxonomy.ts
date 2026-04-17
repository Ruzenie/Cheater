/**
 * @file task-taxonomy.ts — 前端任务分类体系（v2 — 注册表模式）
 *
 * 本文件实现了 Cheater 系统的**零成本任务分类引擎**：
 * 通过基于关键词的加权匹配（不调用任何 LLM），将用户的前端需求文本
 * 自动分类到预定义的任务类别中，并据此路由到合适的模型等级。
 *
 * 架构角色：
 *   - 位于流水线最前端，是需求进入系统后的第一个处理环节
 *   - 分类结果决定后续使用哪个模型等级（executor/worker/reasoner）
 *   - 与 models.ts 的 routeModel() 互补：本文件做"细粒度分类"，routeModel() 做"粗粒度路由"
 *
 * 核心设计：
 *   - **注册表模式** — 所有类别、关键词、路由规则都通过 Map 注册表管理，运行时可动态扩展
 *   - **两层分类** — 任务分为"交互层（View）"和"逻辑层（Logic）"两大维度
 *   - **加权匹配** — 每个类别有权重（weight），匹配关键词数 × 权重 = 最终得分
 *   - **跨层检测** — detectCrossLayer() 可识别同时涉及 View 和 Logic 的复合需求
 *
 * v2 改动：
 *   - 所有类别、关键词、路由规则都通过注册表管理，不再硬编码
 *   - 提供 registerViewCategory() / registerLogicCategory() 注册新类别
 *   - 大型库类（chart、threejs、animation）现在只是默认注册项，用户可以
 *     随时注册新的库类型（如 map、editor、pdf、video 等）
 *   - 关键词、路由、权重都可以在运行时扩展
 *
 * 分类体系总览：
 * ┌─────────────────────────────────────────────────────────┐
 * │                      前端任务分类                        │
 * ├──────────────────────┬──────────────────────────────────┤
 * │    交互层（View）     │       逻辑层（Logic）             │
 * │  视觉+体验+样式       │    数据+通信+算法+性能             │
 * ├──────────────────────┼──────────────────────────────────┤
 * │  ① 原生类            │  ① 前后端通信                     │
 * │  ② 框架类            │  ② 数据处理                       │
 * │  ③ 大型库类（可扩展） │  ③ 性能调优                       │
 * │    - 图表 / 3D / 动画 │  ④ 状态管理 / 算法                │
 * │    - 地图 / 编辑器... │                                  │
 * └──────────────────────┴──────────────────────────────────┘
 *
 * @module config/task-taxonomy
 */

import type { ModelTier } from './models.js'; // 引入模型等级类型

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/**
 * 第一维：任务层级
 *
 * - `view`  — 交互层：与视觉、体验、样式相关的任务
 * - `logic` — 逻辑层：与数据、通信、算法、性能相关的任务
 */
export type TaskLayer = 'view' | 'logic';

/**
 * 内置交互层子类别（基础类）
 *
 * 这些是系统预注册的 View 层类别，覆盖前端开发中最常见的交互场景。
 * 用户可通过 registerViewCategory() 注册更多自定义类别。
 */
export type BuiltinViewCategory =
  | 'native-dom' // 原生 HTML/DOM 结构操作
  | 'native-css' // 原生 CSS 调优 / 自定义覆盖样式
  | 'native-js' // 原生 JS 交互 / 动画 / 事件处理
  | 'framework-custom' // 框架 + 自定义样式（如 Tailwind、CSS Modules）
  | 'framework-lib' // 框架 + 组件库（如 Ant Design、Element Plus）
  | 'framework-lib-custom'; // 框架 + 组件库 + 自定义样式（二次封装/主题定制）

/**
 * 内置逻辑层子类别
 *
 * 覆盖前端逻辑层面的核心任务类型。
 */
export type BuiltinLogicCategory =
  | 'api-communication' // 前后端通信（REST / GraphQL / WebSocket / SSE）
  | 'data-processing' // 大数据处理 / 虚拟滚动 / 分页 / 数据转换
  | 'performance' // 性能调优 / 重绘优化 / 内存管理 / 打包优化
  | 'state-management' // 复杂状态管理（Redux / Zustand / Pinia 等）
  | 'algorithm'; // 前端算法（搜索、排序、diff、防抖节流等）

/**
 * ViewCategory / LogicCategory 使用 string 类型联合
 *
 * 内置类型只作为预注册项提供类型提示，
 * 用户可以注册任意新类别名（如 'map'、'editor'、'pdf-viewer'）。
 * 使用 `(string & {})` 技巧保留内置类型的自动补全，同时允许任意字符串。
 */
export type ViewCategory = BuiltinViewCategory | (string & {});
export type LogicCategory = BuiltinLogicCategory | (string & {});

/**
 * 统一分类结果
 *
 * classifyTask() 的返回值，包含分类结论和路由建议。
 * 上层消费者可据此决定使用哪个模型、预估上下文长度、是否需要拆分任务等。
 */
export interface TaskClassification {
  /** 所属层级（交互层 / 逻辑层） */
  layer: TaskLayer;
  /** 具体分类 ID（如 'chart'、'native-css'、'api-communication'） */
  category: ViewCategory | LogicCategory;
  /** 预估复杂度 */
  complexity: 'simple' | 'medium' | 'complex';
  /** 推荐使用的模型等级 */
  recommendedTier: ModelTier;
  /** 预估需要的上下文 token 量（用于预算估算和上下文窗口规划） */
  estimatedContextTokens: number;
  /** 是否可能需要会话交接（当 executor 的上下文窗口不够时为 true） */
  mayNeedHandoff: boolean;
  /** 分类依据（人类可读的推理过程说明） */
  reasoning: string;
}

// ══════════════════════════════════════════════════════
//  路由条目类型
// ══════════════════════════════════════════════════════

/**
 * 路由条目 — 定义某个分类在不同复杂度下的模型路由策略
 *
 * 每个复杂度等级对应一个 { tier, estimatedTokens } 对：
 *   - tier — 推荐使用的模型等级
 *   - estimatedTokens — 该场景下预估需要的上下文 token 数
 */
export type RoutingEntry = Record<
  'simple' | 'medium' | 'complex',
  {
    /** 推荐的模型等级 */
    tier: ModelTier;
    /** 预估上下文 token 数（用于预算和上下文窗口管理） */
    estimatedTokens: number;
  }
>;

// ══════════════════════════════════════════════════════
//  分类注册表
// ══════════════════════════════════════════════════════

/**
 * 分类注册条目 — 描述一个可注册的任务分类
 *
 * 每个条目包含类别标识、所属层级、关键词列表、匹配权重和路由策略。
 * 通过 registerViewCategory() / registerLogicCategory() 注册到全局注册表。
 */
export interface CategoryRegistration {
  /** 类别唯一 ID，如 'chart', 'threejs', 'map', 'pdf-viewer' */
  id: string;
  /** 所属层级（view = 交互层 / logic = 逻辑层） */
  layer: TaskLayer;
  /** 人类可读名称（用于日志和调试输出） */
  displayName: string;
  /** 关键词列表（全部小写），用于与需求文本进行匹配 */
  keywords: string[];
  /** 关键词匹配权重（越大优先级越高），最终得分 = 匹配关键词数 × weight */
  weight: number;
  /** 复杂度 → 模型路由映射 */
  routing: RoutingEntry;
}

/**
 * 全局分类注册表（单例 Map）
 *
 * key = 类别 ID（如 'chart', 'native-dom', 'api-communication'）
 * value = 完整的 CategoryRegistration 条目
 *
 * 模块加载时会自动注册内置的默认分类（registerDefaults()）。
 */
const categoryRegistry = new Map<string, CategoryRegistration>();

// ── 注册表 API ─────────────────────────────────────────
// 以下函数构成分类体系的公共 API，允许外部在运行时扩展分类能力。

/**
 * 注册一个交互层（View）分类
 *
 * 自动将 layer 设为 'view'，调用者只需提供除 layer 外的其他字段。
 * 如果 id 已存在，会覆盖之前的注册。
 *
 * @param reg - 分类注册信息（不含 layer 字段）
 *
 * @example
 * ```ts
 * // 注册地图库类别
 * registerViewCategory({
 *   id: 'map',
 *   displayName: '地图类（Leaflet / Mapbox）',
 *   keywords: ['leaflet', 'mapbox', 'openlayers', '地图', 'map', 'gis', '坐标', 'marker'],
 *   weight: 3,
 *   routing: {
 *     simple:  { tier: 'worker',   estimatedTokens: 6000 },
 *     medium:  { tier: 'worker',   estimatedTokens: 15000 },
 *     complex: { tier: 'reasoner', estimatedTokens: 30000 },
 *   },
 * });
 * ```
 */
export function registerViewCategory(reg: Omit<CategoryRegistration, 'layer'>): void {
  categoryRegistry.set(reg.id, { ...reg, layer: 'view' });
}

/**
 * 注册一个逻辑层（Logic）分类
 *
 * 自动将 layer 设为 'logic'，调用者只需提供除 layer 外的其他字段。
 *
 * @param reg - 分类注册信息（不含 layer 字段）
 *
 * @example
 * ```ts
 * registerLogicCategory({
 *   id: 'testing',
 *   displayName: '自动化测试',
 *   keywords: ['jest', 'vitest', 'cypress', 'playwright', '单元测试', 'e2e'],
 *   weight: 2,
 *   routing: {
 *     simple:  { tier: 'executor', estimatedTokens: 3000 },
 *     medium:  { tier: 'worker',   estimatedTokens: 8000 },
 *     complex: { tier: 'worker',   estimatedTokens: 16000 },
 *   },
 * });
 * ```
 */
export function registerLogicCategory(reg: Omit<CategoryRegistration, 'layer'>): void {
  categoryRegistry.set(reg.id, { ...reg, layer: 'logic' });
}

/**
 * 注销一个已注册的分类
 *
 * @param id - 要注销的类别 ID
 * @returns 是否成功注销（若类别不存在则返回 false）
 */
export function unregisterCategory(id: string): boolean {
  return categoryRegistry.delete(id);
}

/**
 * 获取所有已注册分类的快照（只读数组）
 *
 * @returns 当前注册表中所有分类的只读副本
 */
export function getRegisteredCategories(): readonly CategoryRegistration[] {
  return [...categoryRegistry.values()];
}

/**
 * 按层级筛选已注册的分类
 *
 * @param layer - 目标层级（'view' 或 'logic'）
 * @returns 属于指定层级的所有分类的只读数组
 */
export function getCategoriesByLayer(layer: TaskLayer): readonly CategoryRegistration[] {
  return [...categoryRegistry.values()].filter((c) => c.layer === layer);
}

/**
 * 为已注册的分类追加关键词（增量添加，不覆盖原有关键词）
 *
 * 使用 Set 去重，确保不会产生重复关键词。
 * 新关键词会自动转为小写。
 *
 * @param id          - 目标类别 ID（必须已注册）
 * @param newKeywords - 要追加的关键词数组
 * @throws 类别未注册时抛出错误
 */
export function extendCategoryKeywords(id: string, newKeywords: string[]): void {
  const reg = categoryRegistry.get(id);
  if (!reg) {
    throw new Error(
      `Category "${id}" is not registered. Call registerViewCategory/registerLogicCategory first.`,
    );
  }
  // 使用 Set 去重，防止重复关键词影响匹配得分
  const existing = new Set(reg.keywords);
  for (const kw of newKeywords) {
    existing.add(kw.toLowerCase()); // 统一转小写，与匹配时的 toLowerCase() 保持一致
  }
  reg.keywords = [...existing];
}

/**
 * 更新已注册分类的路由配置（部分更新，使用 spread 合并）
 *
 * @param id      - 目标类别 ID（必须已注册）
 * @param routing - 要更新的路由条目（可以只传部分复杂度级别）
 * @throws 类别未注册时抛出错误
 */
export function updateCategoryRouting(id: string, routing: Partial<RoutingEntry>): void {
  const reg = categoryRegistry.get(id);
  if (!reg) {
    throw new Error(`Category "${id}" is not registered.`);
  }
  reg.routing = { ...reg.routing, ...routing };
}

// ══════════════════════════════════════════════════════
//  默认分类注册（内置类别）
// ══════════════════════════════════════════════════════

/**
 * 注册所有内置的默认分类
 *
 * 在模块加载时自动调用，将预定义的交互层和逻辑层类别注册到全局注册表。
 * 这些默认分类覆盖了前端开发中最常见的任务类型，用户可通过
 * 注册表 API 在运行时添加新类别或扩展已有类别。
 *
 * 注册顺序：
 *   1. 交互层 — 原生类（native-dom, native-css, native-js）
 *   2. 交互层 — 框架类（framework-lib, framework-custom, framework-lib-custom）
 *   3. 交互层 — 大型库类（chart, threejs, animation）
 *   4. 逻辑层（api-communication, data-processing, performance, state-management, algorithm）
 */
function registerDefaults(): void {
  // ── 交互层：原生类 ──────────────────────────────
  // 这三个类别对应不使用框架、直接操作 DOM/CSS/JS 的场景
  // 权重较低（weight=1），因为原生开发一般复杂度不高

  registerViewCategory({
    id: 'native-dom',
    displayName: '原生 DOM',
    keywords: [
      'dom',
      'html',
      '语义化',
      'semantic',
      '标签',
      'tag',
      'element',
      'node',
      'queryselector',
      'getelementby',
      'createelement',
      '节点',
      'fragment',
    ],
    weight: 1,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 2000 },
      medium: { tier: 'executor', estimatedTokens: 4000 },
      complex: { tier: 'worker', estimatedTokens: 8000 },
    },
  });

  registerViewCategory({
    id: 'native-css',
    displayName: '原生 CSS',
    keywords: [
      'css',
      'scss',
      'sass',
      'less',
      'stylesheet',
      '样式',
      '布局',
      'layout',
      'flexbox',
      'grid',
      'position',
      'media query',
      '响应式',
      'responsive',
      'animation',
      '@keyframes',
      'transition',
      'transform',
      '伪元素',
      '选择器',
      'z-index',
      'overflow',
      'custom property',
      'css variable',
    ],
    weight: 1,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 1500 },
      medium: { tier: 'executor', estimatedTokens: 3000 },
      complex: { tier: 'worker', estimatedTokens: 6000 },
    },
  });

  registerViewCategory({
    id: 'native-js',
    displayName: '原生 JS 交互',
    keywords: [
      'vanilla',
      '原生',
      'addeventlistener',
      'classlist',
      'dataset',
      'intersectionobserver',
      'mutationobserver',
      'requestanimationframe',
      'scroll',
      'resize',
      'drag',
      'touch',
      'pointer',
      'gesture',
    ],
    weight: 1,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 3000 },
      medium: { tier: 'worker', estimatedTokens: 6000 },
      complex: { tier: 'worker', estimatedTokens: 12000 },
    },
  });

  // ── 交互层：框架类 ──────────────────────────────
  // 使用前端框架（React/Vue/Svelte）开发组件的场景
  // 权重递增：纯组件库(2) < 自定义样式(1.5) < 组件库+自定义(2.5)

  registerViewCategory({
    id: 'framework-lib',
    displayName: '框架 + 组件库',
    keywords: [
      'ant design',
      'antd',
      'element-ui',
      'element-plus',
      'material-ui',
      'mui',
      'arco',
      'naive-ui',
      'vuetify',
      'shadcn',
      'radix',
      '组件库',
    ],
    weight: 2,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 3000 },
      medium: { tier: 'executor', estimatedTokens: 5000 },
      complex: { tier: 'worker', estimatedTokens: 10000 },
    },
  });

  registerViewCategory({
    id: 'framework-custom',
    displayName: '框架 + 自定义样式',
    keywords: [
      '自定义组件',
      'custom component',
      'tailwind',
      'css module',
      'styled-component',
      '手写样式',
      '定制样式',
    ],
    weight: 1.5,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 4000 },
      medium: { tier: 'worker', estimatedTokens: 8000 },
      complex: { tier: 'worker', estimatedTokens: 16000 },
    },
  });

  registerViewCategory({
    id: 'framework-lib-custom',
    displayName: '框架 + 组件库 + 自定义',
    keywords: [
      '组件库改造',
      '二次封装',
      '主题定制',
      'theme',
      'token',
      '覆盖样式',
      'override',
      '自定义主题',
      'design token',
    ],
    weight: 2.5,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 5000 },
      medium: { tier: 'worker', estimatedTokens: 10000 },
      complex: { tier: 'reasoner', estimatedTokens: 20000 },
    },
  });

  // ── 交互层：大型库类（默认注册，可扩展）──────────
  // 涉及专业可视化/3D/动画库的场景，权重较高（weight=2~3）
  // 这些只是默认注册项，用户可随时注册新库类型（map、editor、pdf 等）

  registerViewCategory({
    id: 'chart',
    displayName: '图表类（ECharts / D3 等）',
    keywords: [
      'echarts',
      'd3',
      'chart',
      '图表',
      'highcharts',
      'antv',
      'g2',
      '可视化',
      'visualization',
      '柱状图',
      '折线图',
      '饼图',
      '热力图',
      '仪表盘',
      'dashboard',
    ],
    weight: 3,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 6000 },
      medium: { tier: 'worker', estimatedTokens: 15000 },
      complex: { tier: 'reasoner', estimatedTokens: 30000 },
    },
  });

  registerViewCategory({
    id: 'threejs',
    displayName: '3D 类（Three.js / Babylon）',
    keywords: [
      'three.js',
      'threejs',
      '3d',
      'webgl',
      'webgpu',
      'babylon',
      'scene',
      'mesh',
      'geometry',
      'material',
      'shader',
      'glsl',
      'camera',
      'renderer',
      'orbit',
      '三维',
      '模型渲染',
    ],
    weight: 3,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 8000 },
      medium: { tier: 'reasoner', estimatedTokens: 20000 },
      complex: { tier: 'reasoner', estimatedTokens: 40000 },
    },
  });

  registerViewCategory({
    id: 'animation',
    displayName: '动画类（GSAP / Framer Motion）',
    keywords: [
      'gsap',
      'framer motion',
      'lottie',
      'rive',
      'anime.js',
      '动画',
      'animate',
      '过渡',
      'spring',
      'easing',
      'timeline',
      '关键帧',
      'keyframe',
      '缓动',
    ],
    weight: 2,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 3000 },
      medium: { tier: 'worker', estimatedTokens: 8000 },
      complex: { tier: 'reasoner', estimatedTokens: 16000 },
    },
  });

  // ── 逻辑层 ──────────────────────────────────────
  // 与视觉无关的纯逻辑任务：通信、数据、性能、状态、算法

  registerLogicCategory({
    id: 'api-communication',
    displayName: '前后端通信',
    keywords: [
      'api',
      'fetch',
      'axios',
      'http',
      'rest',
      'graphql',
      'websocket',
      'sse',
      'polling',
      '轮询',
      '请求',
      'request',
      'response',
      'cors',
      'interceptor',
      '拦截器',
      '重试',
      'retry',
      'timeout',
    ],
    weight: 2,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 3000 },
      medium: { tier: 'worker', estimatedTokens: 8000 },
      complex: { tier: 'worker', estimatedTokens: 16000 },
    },
  });

  registerLogicCategory({
    id: 'data-processing',
    displayName: '数据处理',
    keywords: [
      '大数据',
      '虚拟滚动',
      'virtual scroll',
      '分页',
      'pagination',
      '数据转换',
      'transform',
      '聚合',
      'aggregate',
      'filter',
      'sort',
      'web worker',
      'wasm',
      '离屏渲染',
      'offscreen',
    ],
    weight: 2.5,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 5000 },
      medium: { tier: 'worker', estimatedTokens: 12000 },
      complex: { tier: 'reasoner', estimatedTokens: 25000 },
    },
  });

  registerLogicCategory({
    id: 'performance',
    displayName: '性能调优',
    keywords: [
      '性能',
      'performance',
      '优化',
      'optimize',
      '渲染',
      'render',
      '重绘',
      'repaint',
      'reflow',
      '回流',
      '内存',
      'memory',
      'gc',
      'profiler',
      'lighthouse',
      '懒加载',
      'lazy',
      'code split',
      '代码分割',
      'tree shaking',
      'bundle',
      '包大小',
    ],
    weight: 2.5,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 6000 },
      medium: { tier: 'reasoner', estimatedTokens: 15000 },
      complex: { tier: 'reasoner', estimatedTokens: 30000 },
    },
  });

  registerLogicCategory({
    id: 'state-management',
    displayName: '状态管理',
    keywords: [
      '状态',
      'state',
      'redux',
      'zustand',
      'pinia',
      'vuex',
      'mobx',
      'jotai',
      'recoil',
      'context',
      'provider',
      '状态机',
      'xstate',
      'finite state',
    ],
    weight: 2,
    routing: {
      simple: { tier: 'executor', estimatedTokens: 4000 },
      medium: { tier: 'worker', estimatedTokens: 10000 },
      complex: { tier: 'reasoner', estimatedTokens: 20000 },
    },
  });

  registerLogicCategory({
    id: 'algorithm',
    displayName: '前端算法',
    keywords: [
      '算法',
      'algorithm',
      '搜索',
      'search',
      '排序',
      'sort',
      '树操作',
      'tree',
      'diff',
      '路径',
      'path',
      '递归',
      'recursive',
      '动态规划',
      'dp',
      '缓存淘汰',
      'lru',
      '防抖',
      'debounce',
      '节流',
      'throttle',
    ],
    weight: 2,
    routing: {
      simple: { tier: 'worker', estimatedTokens: 5000 },
      medium: { tier: 'reasoner', estimatedTokens: 12000 },
      complex: { tier: 'reasoner', estimatedTokens: 25000 },
    },
  });
}

// 模块加载时自动注册默认分类（确保注册表始终有内置类别可用）
registerDefaults();

// ── 复杂度信号词 ─────────────────────────────────────
// 用于从需求文本中推断任务复杂度（simple / medium / complex）
// 如果需求中同时出现复杂和简单信号词，优先判定为 complex（见 classifyTask 实现）

/**
 * 复杂度信号词表
 *
 * - complex: 包含这些词的需求被判定为高复杂度
 * - simple:  包含这些词的需求被判定为低复杂度
 * - 都不包含时默认为 medium
 */
const COMPLEXITY_SIGNALS: Record<'complex' | 'simple', string[]> = {
  complex: [
    '复杂',
    'complex',
    '高级',
    'advanced',
    '大量',
    '海量',
    '高并发',
    '实时',
    'realtime',
    '多层',
    '嵌套',
    'nested',
    '深度',
    '精细',
    '大规模',
    '企业级',
    'enterprise',
    '高性能',
    '毫秒级',
  ],
  simple: [
    '简单',
    'simple',
    '基础',
    'basic',
    '最小',
    'minimal',
    '快速',
    'quick',
    '原型',
    'prototype',
    '演示',
    'demo',
    '示例',
    'example',
  ],
};

// ══════════════════════════════════════════════════════
//  核心分类函数
// ══════════════════════════════════════════════════════

/**
 * 对前端需求进行自动分类（零 LLM 成本核心函数）
 *
 * 算法流程：
 *   1. 遍历注册表，用关键词匹配计算每个分类的加权得分
 *   2. 取最高得分的分类作为结果（无匹配时回退到 'framework-custom'）
 *   3. 根据复杂度信号词判定 simple / medium / complex
 *   4. 查路由表获取推荐模型等级和预估 token 数
 *   5. 判断是否可能需要会话交接（executor 的上下文窗口不够时）
 *
 * 设计要点：
 *   - 纯字符串匹配，零 LLM 调用成本
 *   - 支持中英文关键词混合匹配
 *   - 权重机制让专业库类别（chart/threejs）在模糊匹配中获得更高优先级
 *
 * @param requirement - 用户的原始需求文本（中文或英文均可）
 * @returns 完整的分类结果，包含层级、类别、复杂度、模型推荐等信息
 *
 * @example
 * ```ts
 * const result = classifyTask('用 ECharts 实现一个复杂的仪表盘');
 * // → { layer: 'view', category: 'chart', complexity: 'complex',
 * //     recommendedTier: 'reasoner', estimatedContextTokens: 30000, ... }
 * ```
 */
export function classifyTask(requirement: string): TaskClassification {
  const lower = requirement.toLowerCase(); // 统一转小写，实现大小写无关匹配

  // Step 1: 遍历注册表，计算每个分类的加权得分
  // 得分公式：score = 匹配到的关键词数量 × 该分类的权重（weight）
  const scores: Array<{ reg: CategoryRegistration; score: number; matchedKeywords: string[] }> = [];

  for (const reg of categoryRegistry.values()) {
    // 检查需求文本中包含哪些关键词
    const matched = reg.keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      scores.push({
        reg,
        score: matched.length * reg.weight, // 加权得分
        matchedKeywords: matched,
      });
    }
  }

  // Step 2: 按得分降序排列，取最高分的分类作为最佳匹配
  scores.sort((a, b) => b.score - a.score);

  let layer: TaskLayer;
  let category: string;
  let matchedKeywords: string[];
  let routing: RoutingEntry;

  if (scores.length > 0) {
    // 有匹配结果 — 使用得分最高的分类
    const best = scores[0];
    layer = best.reg.layer;
    category = best.reg.id;
    matchedKeywords = best.matchedKeywords;
    routing = best.reg.routing;
  } else {
    // 无任何关键词匹配 — 安全回退到"框架自定义组件"
    // 这是最通用的类别，适合大多数未明确分类的前端需求
    layer = 'view';
    category = 'framework-custom';
    matchedKeywords = [];
    routing = categoryRegistry.get('framework-custom')!.routing;
  }

  // Step 3: 根据复杂度信号词判定任务复杂度
  // 优先检测 complex 信号（宁可高估不可低估），都不匹配则默认 medium
  let complexity: 'simple' | 'medium' | 'complex' = 'medium';
  if (COMPLEXITY_SIGNALS.complex.some((s) => lower.includes(s))) {
    complexity = 'complex';
  } else if (COMPLEXITY_SIGNALS.simple.some((s) => lower.includes(s))) {
    complexity = 'simple';
  }

  // Step 4: 查路由表，获取推荐模型等级和预估 token 数
  const route = routing[complexity];

  // Step 5: 判断是否可能需要会话交接
  // 当使用 executor（弱模型）但预估 token 数超过其上下文窗口限制时，
  // 标记需要交接给更强的模型处理
  const WEAK_MODEL_CONTEXT_LIMIT = 16000; // executor 的上下文窗口限制
  const mayNeedHandoff =
    route.tier === 'executor' && route.estimatedTokens > WEAK_MODEL_CONTEXT_LIMIT;

  // 构造分类结果并附上推理过程说明
  return {
    layer,
    category,
    complexity,
    recommendedTier: route.tier,
    estimatedContextTokens: route.estimatedTokens,
    mayNeedHandoff,
    reasoning:
      matchedKeywords.length > 0
        ? `匹配关键词: [${matchedKeywords.join(', ')}] → ${layer}/${category} (${complexity})`
        : `未匹配到特定关键词，默认分类为 ${layer}/${category}`,
  };
}

/**
 * 检测需求是否跨层（同时涉及交互层和逻辑层）
 *
 * 跨层需求示例："用 ECharts 实现一个实时数据仪表盘，需要 WebSocket 推送"
 * → 交互层（chart）+ 逻辑层（api-communication），建议拆分为两个子任务并行处理。
 *
 * 算法：遍历注册表计算 View 和 Logic 两侧的总分，
 *       双侧得分均 > 0 即判定为跨层需求。
 *
 * @param requirement - 用户的原始需求文本
 * @returns 跨层检测结果，包含双侧得分和处理建议
 *
 * @example
 * ```ts
 * const result = detectCrossLayer('用 ECharts 展示 WebSocket 实时数据');
 * // → { isCrossLayer: true, viewScore: 6, logicScore: 4, suggestion: '跨层需求...' }
 * ```
 */
export function detectCrossLayer(requirement: string): {
  isCrossLayer: boolean;
  viewScore: number;
  logicScore: number;
  suggestion: string;
} {
  const lower = requirement.toLowerCase();
  let viewScore = 0; // 交互层累计得分
  let logicScore = 0; // 逻辑层累计得分

  // 遍历所有注册的分类，按层级累加匹配得分
  for (const reg of categoryRegistry.values()) {
    const matched = reg.keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      const score = matched.length * reg.weight;
      if (reg.layer === 'view') viewScore += score; // 交互层得分累加
      else logicScore += score; // 逻辑层得分累加
    }
  }

  // 双侧得分均 > 0 即为跨层需求
  const isCrossLayer = viewScore > 0 && logicScore > 0;

  return {
    isCrossLayer,
    viewScore,
    logicScore,
    suggestion: isCrossLayer
      ? `跨层需求（view: ${viewScore.toFixed(1)}, logic: ${logicScore.toFixed(1)}）。建议拆分为交互子任务和逻辑子任务并行处理。`
      : `单层需求（${viewScore > logicScore ? 'view' : 'logic'}），无需拆分。`,
  };
}
