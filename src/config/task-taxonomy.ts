/**
 * task-taxonomy.ts — 前端任务分类体系（v2 — 注册表模式）
 *
 * 将前端工作分为两大层 × 多种类型，精准匹配模型能力。
 *
 * ✅ v2 改动：
 *   - 所有类别、关键词、路由规则都通过注册表管理，不再硬编码
 *   - 提供 registerViewCategory() / registerLogicCategory() 注册新类别
 *   - 大型库类（chart、threejs、animation）现在只是默认注册项，用户可以
 *     随时注册新的库类型（如 map、editor、pdf、video 等）
 *   - 关键词、路由、权重都可以在运行时扩展
 *
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
 */

import type { ModelTier } from '../config/models.js';

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

/** 第一维：层级 */
export type TaskLayer = 'view' | 'logic';

/** 内置交互层子类（基础类） */
export type BuiltinViewCategory =
  | 'native-dom'           // 原生 HTML/DOM 结构
  | 'native-css'           // 原生 CSS 调优 / 自定义覆盖
  | 'native-js'            // 原生 JS 交互 / 动画
  | 'framework-custom'     // 框架 + 自定义样式
  | 'framework-lib'        // 框架 + 组件库（Ant Design / Element 等）
  | 'framework-lib-custom'; // 框架 + 组件库 + 自定义样式

/** 内置逻辑层子类 */
export type BuiltinLogicCategory =
  | 'api-communication'    // 前后端通信（REST/GraphQL/WS）
  | 'data-processing'      // 大数据处理 / 虚拟滚动 / 分页
  | 'performance'          // 性能调优 / 重绘 / 内存
  | 'state-management'     // 复杂状态管理
  | 'algorithm';           // 前端算法

/**
 * ViewCategory / LogicCategory 使用 string 类型，
 * 内置类型只作为预注册项，用户可以注册任意新类别名。
 */
export type ViewCategory = BuiltinViewCategory | (string & {});
export type LogicCategory = BuiltinLogicCategory | (string & {});

/** 统一分类结果 */
export interface TaskClassification {
  layer: TaskLayer;
  category: ViewCategory | LogicCategory;
  complexity: 'simple' | 'medium' | 'complex';
  recommendedTier: ModelTier;
  /** 预估需要的上下文 token 量 */
  estimatedContextTokens: number;
  /** 是否可能需要会话交接（超出弱模型上下文） */
  mayNeedHandoff: boolean;
  /** 分类依据 */
  reasoning: string;
}

// ══════════════════════════════════════════════════════
//  路由条目类型
// ══════════════════════════════════════════════════════

export type RoutingEntry = Record<'simple' | 'medium' | 'complex', {
  tier: ModelTier;
  estimatedTokens: number;
}>;

// ══════════════════════════════════════════════════════
//  分类注册表
// ══════════════════════════════════════════════════════

export interface CategoryRegistration {
  /** 类别 ID，如 'chart', 'threejs', 'map', 'pdf-viewer' */
  id: string;
  /** 所属层级 */
  layer: TaskLayer;
  /** 人类可读名称（用于日志） */
  displayName: string;
  /** 关键词列表（小写） */
  keywords: string[];
  /** 关键词匹配权重（越大优先级越高） */
  weight: number;
  /** 复杂度 → 模型路由 */
  routing: RoutingEntry;
}

/**
 * 全局分类注册表
 * key = category id (如 'chart', 'native-dom', 'api-communication')
 */
const categoryRegistry = new Map<string, CategoryRegistration>();

// ── 注册 API ──────────────────────────────────────────

/**
 * 注册一个交互层分类
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
export function registerViewCategory(
  reg: Omit<CategoryRegistration, 'layer'>,
): void {
  categoryRegistry.set(reg.id, { ...reg, layer: 'view' });
}

/**
 * 注册一个逻辑层分类
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
export function registerLogicCategory(
  reg: Omit<CategoryRegistration, 'layer'>,
): void {
  categoryRegistry.set(reg.id, { ...reg, layer: 'logic' });
}

/**
 * 注销一个分类
 */
export function unregisterCategory(id: string): boolean {
  return categoryRegistry.delete(id);
}

/**
 * 获取所有已注册的分类
 */
export function getRegisteredCategories(): readonly CategoryRegistration[] {
  return [...categoryRegistry.values()];
}

/**
 * 获取指定层级的所有分类
 */
export function getCategoriesByLayer(layer: TaskLayer): readonly CategoryRegistration[] {
  return [...categoryRegistry.values()].filter((c) => c.layer === layer);
}

/**
 * 为已注册的分类追加关键词（不覆盖原有关键词）
 */
export function extendCategoryKeywords(id: string, newKeywords: string[]): void {
  const reg = categoryRegistry.get(id);
  if (!reg) {
    throw new Error(`Category "${id}" is not registered. Call registerViewCategory/registerLogicCategory first.`);
  }
  const existing = new Set(reg.keywords);
  for (const kw of newKeywords) {
    existing.add(kw.toLowerCase());
  }
  reg.keywords = [...existing];
}

/**
 * 更新已注册分类的路由配置
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

function registerDefaults(): void {
  // ── 交互层：原生类 ──────────────────────────────

  registerViewCategory({
    id: 'native-dom',
    displayName: '原生 DOM',
    keywords: [
      'dom', 'html', '语义化', 'semantic', '标签', 'tag', 'element', 'node',
      'queryselector', 'getelementby', 'createelement', '节点', 'fragment',
    ],
    weight: 1,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 2000 },
      medium:  { tier: 'executor', estimatedTokens: 4000 },
      complex: { tier: 'worker',   estimatedTokens: 8000 },
    },
  });

  registerViewCategory({
    id: 'native-css',
    displayName: '原生 CSS',
    keywords: [
      'css', 'scss', 'sass', 'less', 'stylesheet', '样式', '布局', 'layout',
      'flexbox', 'grid', 'position', 'media query', '响应式', 'responsive',
      'animation', '@keyframes', 'transition', 'transform', '伪元素', '选择器',
      'z-index', 'overflow', 'custom property', 'css variable',
    ],
    weight: 1,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 1500 },
      medium:  { tier: 'executor', estimatedTokens: 3000 },
      complex: { tier: 'worker',   estimatedTokens: 6000 },
    },
  });

  registerViewCategory({
    id: 'native-js',
    displayName: '原生 JS 交互',
    keywords: [
      'vanilla', '原生', 'addeventlistener', 'classlist', 'dataset',
      'intersectionobserver', 'mutationobserver', 'requestanimationframe',
      'scroll', 'resize', 'drag', 'touch', 'pointer', 'gesture',
    ],
    weight: 1,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 3000 },
      medium:  { tier: 'worker',   estimatedTokens: 6000 },
      complex: { tier: 'worker',   estimatedTokens: 12000 },
    },
  });

  // ── 交互层：框架类 ──────────────────────────────

  registerViewCategory({
    id: 'framework-lib',
    displayName: '框架 + 组件库',
    keywords: [
      'ant design', 'antd', 'element-ui', 'element-plus', 'material-ui',
      'mui', 'arco', 'naive-ui', 'vuetify', 'shadcn', 'radix', '组件库',
    ],
    weight: 2,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 3000 },
      medium:  { tier: 'executor', estimatedTokens: 5000 },
      complex: { tier: 'worker',   estimatedTokens: 10000 },
    },
  });

  registerViewCategory({
    id: 'framework-custom',
    displayName: '框架 + 自定义样式',
    keywords: [
      '自定义组件', 'custom component', 'tailwind', 'css module',
      'styled-component', '手写样式', '定制样式',
    ],
    weight: 1.5,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 4000 },
      medium:  { tier: 'worker',   estimatedTokens: 8000 },
      complex: { tier: 'worker',   estimatedTokens: 16000 },
    },
  });

  registerViewCategory({
    id: 'framework-lib-custom',
    displayName: '框架 + 组件库 + 自定义',
    keywords: [
      '组件库改造', '二次封装', '主题定制', 'theme', 'token', '覆盖样式',
      'override', '自定义主题', 'design token',
    ],
    weight: 2.5,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 5000 },
      medium:  { tier: 'worker',   estimatedTokens: 10000 },
      complex: { tier: 'reasoner', estimatedTokens: 20000 },
    },
  });

  // ── 交互层：大型库类（默认注册，可扩展）──────────

  registerViewCategory({
    id: 'chart',
    displayName: '图表类（ECharts / D3 等）',
    keywords: [
      'echarts', 'd3', 'chart', '图表', 'highcharts', 'antv', 'g2',
      '可视化', 'visualization', '柱状图', '折线图', '饼图', '热力图',
      '仪表盘', 'dashboard',
    ],
    weight: 3,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 6000 },
      medium:  { tier: 'worker',   estimatedTokens: 15000 },
      complex: { tier: 'reasoner', estimatedTokens: 30000 },
    },
  });

  registerViewCategory({
    id: 'threejs',
    displayName: '3D 类（Three.js / Babylon）',
    keywords: [
      'three.js', 'threejs', '3d', 'webgl', 'webgpu', 'babylon',
      'scene', 'mesh', 'geometry', 'material', 'shader', 'glsl',
      'camera', 'renderer', 'orbit', '三维', '模型渲染',
    ],
    weight: 3,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 8000 },
      medium:  { tier: 'reasoner', estimatedTokens: 20000 },
      complex: { tier: 'reasoner', estimatedTokens: 40000 },
    },
  });

  registerViewCategory({
    id: 'animation',
    displayName: '动画类（GSAP / Framer Motion）',
    keywords: [
      'gsap', 'framer motion', 'lottie', 'rive', 'anime.js',
      '动画', 'animate', '过渡', 'spring', 'easing', 'timeline',
      '关键帧', 'keyframe', '缓动',
    ],
    weight: 2,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 3000 },
      medium:  { tier: 'worker',   estimatedTokens: 8000 },
      complex: { tier: 'reasoner', estimatedTokens: 16000 },
    },
  });

  // ── 逻辑层 ──────────────────────────────────────

  registerLogicCategory({
    id: 'api-communication',
    displayName: '前后端通信',
    keywords: [
      'api', 'fetch', 'axios', 'http', 'rest', 'graphql', 'websocket',
      'sse', 'polling', '轮询', '请求', 'request', 'response', 'cors',
      'interceptor', '拦截器', '重试', 'retry', 'timeout',
    ],
    weight: 2,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 3000 },
      medium:  { tier: 'worker',   estimatedTokens: 8000 },
      complex: { tier: 'worker',   estimatedTokens: 16000 },
    },
  });

  registerLogicCategory({
    id: 'data-processing',
    displayName: '数据处理',
    keywords: [
      '大数据', '虚拟滚动', 'virtual scroll', '分页', 'pagination',
      '数据转换', 'transform', '聚合', 'aggregate', 'filter', 'sort',
      'web worker', 'wasm', '离屏渲染', 'offscreen',
    ],
    weight: 2.5,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 5000 },
      medium:  { tier: 'worker',   estimatedTokens: 12000 },
      complex: { tier: 'reasoner', estimatedTokens: 25000 },
    },
  });

  registerLogicCategory({
    id: 'performance',
    displayName: '性能调优',
    keywords: [
      '性能', 'performance', '优化', 'optimize', '渲染', 'render',
      '重绘', 'repaint', 'reflow', '回流', '内存', 'memory', 'gc',
      'profiler', 'lighthouse', '懒加载', 'lazy', 'code split',
      '代码分割', 'tree shaking', 'bundle', '包大小',
    ],
    weight: 2.5,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 6000 },
      medium:  { tier: 'reasoner', estimatedTokens: 15000 },
      complex: { tier: 'reasoner', estimatedTokens: 30000 },
    },
  });

  registerLogicCategory({
    id: 'state-management',
    displayName: '状态管理',
    keywords: [
      '状态', 'state', 'redux', 'zustand', 'pinia', 'vuex', 'mobx',
      'jotai', 'recoil', 'context', 'provider', '状态机',
      'xstate', 'finite state',
    ],
    weight: 2,
    routing: {
      simple:  { tier: 'executor', estimatedTokens: 4000 },
      medium:  { tier: 'worker',   estimatedTokens: 10000 },
      complex: { tier: 'reasoner', estimatedTokens: 20000 },
    },
  });

  registerLogicCategory({
    id: 'algorithm',
    displayName: '前端算法',
    keywords: [
      '算法', 'algorithm', '搜索', 'search', '排序', 'sort',
      '树操作', 'tree', 'diff', '路径', 'path', '递归', 'recursive',
      '动态规划', 'dp', '缓存淘汰', 'lru', '防抖', 'debounce',
      '节流', 'throttle',
    ],
    weight: 2,
    routing: {
      simple:  { tier: 'worker',   estimatedTokens: 5000 },
      medium:  { tier: 'reasoner', estimatedTokens: 12000 },
      complex: { tier: 'reasoner', estimatedTokens: 25000 },
    },
  });
}

// 模块加载时自动注册默认分类
registerDefaults();

// ── 复杂度信号 ──────────────────────────────────────

const COMPLEXITY_SIGNALS: Record<'complex' | 'simple', string[]> = {
  complex: [
    '复杂', 'complex', '高级', 'advanced', '大量', '海量', '高并发',
    '实时', 'realtime', '多层', '嵌套', 'nested', '深度', '精细',
    '大规模', '企业级', 'enterprise', '高性能', '毫秒级',
  ],
  simple: [
    '简单', 'simple', '基础', 'basic', '最小', 'minimal', '快速',
    'quick', '原型', 'prototype', '演示', 'demo', '示例', 'example',
  ],
};

// ══════════════════════════════════════════════════════
//  核心分类函数
// ══════════════════════════════════════════════════════

/**
 * 对前端需求进行自动分类
 *
 * 使用加权关键词匹配（零 LLM 成本），不需要调用任何模型。
 * 遍历注册表中的所有分类进行匹配，返回最佳匹配结果。
 */
export function classifyTask(requirement: string): TaskClassification {
  const lower = requirement.toLowerCase();

  // Step 1: 遍历注册表，计算每个分类的得分
  const scores: Array<{ reg: CategoryRegistration; score: number; matchedKeywords: string[] }> = [];

  for (const reg of categoryRegistry.values()) {
    const matched = reg.keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      scores.push({
        reg,
        score: matched.length * reg.weight,
        matchedKeywords: matched,
      });
    }
  }

  // Step 2: 取最高分的分类
  scores.sort((a, b) => b.score - a.score);

  let layer: TaskLayer;
  let category: string;
  let matchedKeywords: string[];
  let routing: RoutingEntry;

  if (scores.length > 0) {
    const best = scores[0];
    layer = best.reg.layer;
    category = best.reg.id;
    matchedKeywords = best.matchedKeywords;
    routing = best.reg.routing;
  } else {
    // 默认：框架自定义组件
    layer = 'view';
    category = 'framework-custom';
    matchedKeywords = [];
    routing = categoryRegistry.get('framework-custom')!.routing;
  }

  // Step 3: 判定复杂度
  let complexity: 'simple' | 'medium' | 'complex' = 'medium';
  if (COMPLEXITY_SIGNALS.complex.some((s) => lower.includes(s))) {
    complexity = 'complex';
  } else if (COMPLEXITY_SIGNALS.simple.some((s) => lower.includes(s))) {
    complexity = 'simple';
  }

  // Step 4: 查路由
  const route = routing[complexity];

  // Step 5: 判断是否可能需要会话交接
  const WEAK_MODEL_CONTEXT_LIMIT = 16000;
  const mayNeedHandoff = route.tier === 'executor' && route.estimatedTokens > WEAK_MODEL_CONTEXT_LIMIT;

  return {
    layer,
    category,
    complexity,
    recommendedTier: route.tier,
    estimatedContextTokens: route.estimatedTokens,
    mayNeedHandoff,
    reasoning: matchedKeywords.length > 0
      ? `匹配关键词: [${matchedKeywords.join(', ')}] → ${layer}/${category} (${complexity})`
      : `未匹配到特定关键词，默认分类为 ${layer}/${category}`,
  };
}

/**
 * 检测需求是否跨层（交互+逻辑都有）
 * 如果跨层，可以拆成两个子任务并行处理
 */
export function detectCrossLayer(requirement: string): {
  isCrossLayer: boolean;
  viewScore: number;
  logicScore: number;
  suggestion: string;
} {
  const lower = requirement.toLowerCase();
  let viewScore = 0;
  let logicScore = 0;

  for (const reg of categoryRegistry.values()) {
    const matched = reg.keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      const score = matched.length * reg.weight;
      if (reg.layer === 'view') viewScore += score;
      else logicScore += score;
    }
  }

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
