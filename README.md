# Cheater

> 多模型前端 Agent — 需求精炼 / 设计分析 / 项目规划 / 代码制作 / 代码审计 / 代码组装

Cheater 是一个基于 [Vercel AI SDK](https://sdk.vercel.ai/) 的 **多模型前端代码生成系统**。

核心理念：**让每个模型只做它最擅长的。**

## 架构概览

```
用户需求（自然语言）
  │
  ▼
┌─────────────────────────────────────────────────┐
│  Step 0  Prompt Refiner         [executor]      │  模糊需求 → 结构化技术规格
│  Step 1  Task Classify + Route  [zero cost]     │  任务分类 + 框架自动检测
│  Step 2  Design Analyzer        [worker]        │  组件树 / 响应式 / 状态设计
│  Step 3  Project Planner        [worker]    ──┐ │
│  Step 4  Code Producer          [multi-tier] ──┤ │  并行执行 (fork-join)
│  Step 5  Code Auditor           [reasoner]     │ │  静态规则 + 深度分析 (最多 3 轮)
│  Step 6  Code Assembler         [worker]       │ │  组装为可运行项目
│  Step 7  Final Audit            [reasoner]   ──┘ │
└─────────────────────────────────────────────────┘
  │
  ▼
output/ 目录 → npm install && npm run dev 即可运行
```

## 三层模型架构

| 层级         | 角色         | 默认模型            | 适用场景                      |
| ------------ | ------------ | ------------------- | ----------------------------- |
| **executor** | 低成本、快速 | `doubao-lite-32k`   | 分类、CSS、脚手架、模板化任务 |
| **worker**   | 性价比平衡   | `deepseek-chat`     | 代码生成、设计分析、项目规划  |
| **reasoner** | 强推理       | `deepseek-reasoner` | 架构决策、深度调试、复杂审计  |

通过 `@ai-sdk/openai` 的 OpenAI 兼容接口，可接入**任何 OpenAI 兼容 API**（DeepSeek、火山引擎、本地 Ollama 等）。

## 快速开始

### 环境准备

```bash
# 克隆仓库
git clone https://github.com/Ruzenie/Cheater.git
cd Cheater

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 API Key
```

### 环境变量配置

支持**独立配置**和**统一配置**两种模式：

```bash
# 独立配置（推荐）— 每个层级使用不同的模型服务
EXECUTOR_API_KEY=your_key    EXECUTOR_BASE_URL=https://ark.cn-beijing.volces.com/api/v3    EXECUTOR_MODEL=doubao-seed-2-0-lite-260215
WORKER_API_KEY=your_key      WORKER_BASE_URL=https://api.deepseek.com/v1                   WORKER_MODEL=deepseek-chat
REASONER_API_KEY=your_key    REASONER_BASE_URL=https://api.deepseek.com/v1                 REASONER_MODEL=deepseek-reasoner

# 统一配置 — 三个层级使用同一个服务
LLM_API_KEY=your_key
LLM_BASE_URL=https://api.deepseek.com/v1
```

### 运行 Demo

```bash
# 单步骤运行
pnpm demo:refine      # 需求精炼
pnpm demo:design      # 设计分析
pnpm demo:code        # 代码生成
pnpm demo:audit       # 代码审计
pnpm demo:plan        # 项目规划

# 完整流水线
pnpm demo:full        # 全流程（需求 → 设计 → 代码 → 审计 → 组装）
pnpm demo:assemble    # 设计 → 规划 → 代码 → 组装
```

### 编程接口

```typescript
import { createProviders, runOrchestrator } from './src/index.js';

const providers = createProviders();
const result = await runOrchestrator(
  '使用 React 实现一个响应式的登录界面，支持亮暗色切换',
  providers,
  {
    framework: 'react',
    styleMethod: 'css-modules',
    darkMode: true,
    writeToFS: true,
    outputDir: './output/my-project',
    budgetLimit: 5.0,
    concurrency: 5,
  },
);

// result.assembly.files → 完整项目文件
// result.totalCost      → 总花费 (USD)
// result.finalVerdict   → 'passed' | 'failed' | 'partial'
```

也可以单独调用各个 Agent：

```typescript
import { createProviders } from './src/config/index.js';
import { runPromptRefiner } from './src/agents/prompt-refiner.js';
import { runDesignAnalyzer } from './src/agents/design-analyzer.js';

const providers = createProviders();

// 只做需求精炼
const refined = await runPromptRefiner('帮我搞个登录页面', providers);

// 只做设计分析
const design = await runDesignAnalyzer(refined.refined, providers, { framework: 'react' });
```

## 支持的框架

| 框架        | 输出格式               | 自动检测关键词       |
| ----------- | ---------------------- | -------------------- |
| **React**   | `.tsx` + `.module.css` | react, tsx, jsx      |
| **Vue**     | `.vue` SFC             | vue, 组合式          |
| **Svelte**  | `.svelte` (runes)      | svelte               |
| **Vanilla** | `HTML + CSS + JS`      | 原生, html, 不要框架 |

## 项目结构

```
Cheater/
├── src/
│   ├── agents/          # 7 个核心 Agent
│   ├── config/          # 模型配置 / Provider 初始化 / 任务分类
│   ├── generators/      # 可插拔的框架代码生成器
│   ├── middleware/       # 缓存 / 成本追踪 / 遥测 / 输出修正
│   ├── rules/           # 零 LLM 成本的静态扫描规则
│   ├── session/         # 会话管理 / 断点续传
│   ├── tools/           # Agent 可调用的工具函数
│   ├── utils/           # JSON 解析 / 流式处理
│   └── index.ts         # 公共 API 入口
├── demo/                # 各步骤的演示脚本
└── output/              # 生成的项目输出目录
```

## 核心特性

- **智能模型路由** — 根据任务类型和复杂度自动选择最优模型层级
- **并行执行** — 项目规划与代码生成并行；所有组件并行生成（可配置并发数）
- **零成本分类** — 任务分类和静态审计使用正则规则，不消耗 LLM Token
- **三重审计** — 安全扫描 (XSS/eval) + 可访问性检查 + 性能反模式检测
- **断点续传** — 流水线每步自动保存检查点，崩溃后从断点恢复
- **预算控制** — 可设定美元上限（默认 $5.00），超支自动停止
- **成本报告** — 每次调用的 Token 用量和费用明细
- **容错 JSON 解析** — 自动处理 Markdown code fence、中文前缀、尾逗号等格式问题
- **中间件栈** — 缓存 → 成本追踪 → 输出修正 → Prompt 增强，可扩展

## 可用脚本

```bash
pnpm build            # TypeScript 编译
pnpm typecheck        # 类型检查
pnpm lint             # ESLint 检查
pnpm lint:fix         # 自动修复
pnpm format           # Prettier 格式化
pnpm test             # 运行测试
pnpm test:watch       # 监听模式
pnpm test:coverage    # 覆盖率报告
```

## 调试选项

```bash
DEBUG_COST=true       # 打印每次调用的成本明细
DEBUG_CACHE=true      # 打印缓存命中/未命中
NODE_ENV=production   # 禁用缓存中间件
```

## 技术栈

- **Runtime**: Node.js + TypeScript (ESM)
- **AI SDK**: Vercel AI SDK v6 + @ai-sdk/openai
- **Schema**: Zod
- **Lint**: ESLint + Prettier
- **Test**: Vitest

## License

MIT
