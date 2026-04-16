/**
 * project-planner.ts — 项目结构规划师 Agent
 *
 * 在设计分析之后、代码生成之前运行。
 * 根据精炼需求 + 组件树 + 框架选择，规划完整的前端项目结构：
 *   - 目录层级（遵循框架约定）
 *   - 配置文件清单（package.json, tsconfig, vite.config 等）
 *   - 入口文件结构（main.tsx, App.tsx, index.html 等）
 *   - 依赖清单（需要安装的 npm 包）
 *   - 组件 → 文件路径映射
 *   - 可选的脚手架命令
 *
 * 模型策略：
 *   - 结构规划 → worker（需要理解框架约定）
 *   - 配置文件 → 纯模板 / executor（确定性内容）
 */

import { streamText } from 'ai';
import { z } from 'zod';
import { getWrappedModel, type AllProviders } from '../config/index.js';
import { frontendAgentTelemetry } from '../middleware/telemetry.js';
import { consumeTextStream } from '../utils/streaming.js';
import { safeParseJson } from '../utils/json.js';
import type { DesignOutput } from './design-analyzer.js';

// ── 输出类型 ──────────────────────────────────────────

export interface ProjectFileEntry {
  /** 相对项目根的路径，如 "src/components/LoginForm/LoginForm.tsx" */
  filePath: string;
  /** 文件角色 */
  role: 'config' | 'entry' | 'component' | 'style' | 'util' | 'asset' | 'type' | 'test';
  /** 文件职责描述 */
  description: string;
  /** 来源方式 */
  generatedBy: 'scaffold' | 'ai' | 'template';
  /** 模板内容（scaffold/template 直接生成的） */
  templateContent?: string;
}

export interface ComponentMapping {
  /** 组件名 */
  componentName: string;
  /** 主文件目标路径 */
  targetPath: string;
  /** 组件目录 */
  targetDir: string;
  /** 关联的文件（样式、测试、类型） */
  relatedFiles: string[];
  /** 入口文件中的导入路径 */
  importPath: string;
  /** 是否是布局组件 */
  isLayout: boolean;
}

export interface ProjectStructure {
  /** 项目名 */
  projectName: string;
  /** 框架 */
  framework: string;
  /** 样式方案 */
  styleMethod: string;
  /** 包管理器 */
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** 所有需要创建的目录 */
  directories: string[];
  /** 所有文件及其元信息 */
  files: ProjectFileEntry[];
  /** 生产依赖 */
  dependencies: Record<string, string>;
  /** 开发依赖 */
  devDependencies: Record<string, string>;
  /** npm scripts */
  scripts: Record<string, string>;
  /** 组件 → 文件映射 */
  componentMapping: ComponentMapping[];
  /** 脚手架命令（可选） */
  setupCommands: string[];
  /** 安装命令 */
  installCommand: string;
  /** 开发命令 */
  devCommand: string;
  /** 构建命令 */
  buildCommand: string;
  /** 规划说明 */
  notes: string[];
}

export interface ProjectPlannerResult {
  structure: ProjectStructure;
  /** LLM 增强的规划说明（如果 AI 参与了决策） */
  aiNotes: string[];
  /** 使用的模型层级 */
  modelTiersUsed: string[];
}

// ── Schema ──────────────────────────────────────────────

const AiPlanningResultSchema = z.object({
  projectName: z.string().optional(),
  additionalDirectories: z.array(z.string()).optional().default([]),
  additionalFiles: z.array(z.object({
    filePath: z.string(),
    role: z.string(),
    description: z.string(),
  })).optional().default([]),
  layoutComponents: z.array(z.string()).optional().default([]),
  features: z.array(z.string()).optional().default([]),
  notes: z.array(z.string()).optional().default([]),
  additionalDependencies: z.record(z.string()).optional().default({}),
  additionalDevDependencies: z.record(z.string()).optional().default({}),
});

// ── 框架标准配置 ──────────────────────────────────────

const FRAMEWORK_CONFIGS: Record<string, {
  directories: string[];
  componentBaseDir: string;
  componentExt: string;
  entryFiles: Array<{ path: string; role: ProjectFileEntry['role'] }>;
  defaultScripts: Record<string, string>;
  defaultDeps: Record<string, string>;
  defaultDevDeps: Record<string, string>;
}> = {
  react: {
    directories: ['src', 'src/components', 'src/hooks', 'src/styles', 'src/types', 'src/utils', 'src/assets', 'public'],
    componentBaseDir: 'src/components',
    componentExt: '.tsx',
    entryFiles: [
      { path: 'src/main.tsx', role: 'entry' },
      { path: 'src/App.tsx', role: 'entry' },
      { path: 'index.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
    defaultScripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
    defaultDeps: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    defaultDevDeps: {
      '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0',
      '@vitejs/plugin-react': '^4.4.0', typescript: '^5.7.0', vite: '^6.0.0',
    },
  },
  vue: {
    directories: ['src', 'src/components', 'src/views', 'src/composables', 'src/stores', 'src/styles', 'src/types', 'src/utils', 'src/assets', 'public'],
    componentBaseDir: 'src/components',
    componentExt: '.vue',
    entryFiles: [
      { path: 'src/main.ts', role: 'entry' },
      { path: 'src/App.vue', role: 'entry' },
      { path: 'index.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
    defaultScripts: { dev: 'vite', build: 'vue-tsc -b && vite build', preview: 'vite preview' },
    defaultDeps: { vue: '^3.5.0' },
    defaultDevDeps: {
      '@vitejs/plugin-vue': '^5.2.0', typescript: '^5.7.0',
      'vue-tsc': '^2.2.0', vite: '^6.0.0',
    },
  },
  svelte: {
    directories: ['src', 'src/lib', 'src/lib/components', 'src/lib/stores', 'src/lib/utils', 'src/lib/types', 'src/routes', 'src/styles', 'static'],
    componentBaseDir: 'src/lib/components',
    componentExt: '.svelte',
    entryFiles: [
      { path: 'src/routes/+page.svelte', role: 'entry' },
      { path: 'src/routes/+layout.svelte', role: 'entry' },
      { path: 'src/app.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
    defaultScripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
    defaultDeps: {},
    defaultDevDeps: {
      '@sveltejs/adapter-auto': '^4.0.0', '@sveltejs/kit': '^2.15.0',
      svelte: '^5.0.0', typescript: '^5.7.0', vite: '^6.0.0',
    },
  },
  'html+css+js': {
    directories: ['styles', 'scripts'],
    componentBaseDir: 'components',
    componentExt: '.html',
    entryFiles: [
      { path: 'index.html', role: 'entry' },
      { path: 'styles/main.css', role: 'style' },
      { path: 'scripts/main.js', role: 'entry' },
    ],
    defaultScripts: { dev: 'npx serve .', build: 'echo "No build step needed"' },
    defaultDeps: {},
    defaultDevDeps: {},
  },
};

const STYLE_DEPS: Record<string, { deps: Record<string, string>; devDeps: Record<string, string> }> = {
  tailwind: { deps: {}, devDeps: { tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' } },
  sass: { deps: {}, devDeps: { sass: '^1.80.0' } },
  'styled-components': { deps: { 'styled-components': '^6.1.0' }, devDeps: { '@types/styled-components': '^5.1.34' } },
  css: { deps: {}, devDeps: {} },
  'css-modules': { deps: {}, devDeps: {} },
};

// ── Telemetry ──

function telemetryConfig(functionId: string) {
  return {
    isEnabled: true,
    functionId,
    integrations: [frontendAgentTelemetry()],
  };
}

// ── 工具函数 ──────────────────────────────────────

function normalizeFrameworkKey(framework: string): string {
  const value = framework.trim().toLowerCase();
  if (value.includes('html') && value.includes('css')) return 'html+css+js';
  if (['vanilla', 'native', 'javascript', 'html'].includes(value)) return 'html+css+js';
  if (['react', 'vue', 'svelte'].includes(value)) return value;
  return 'react';
}

function buildComponentMapping(
  componentNames: string[],
  fwKey: string,
  config: typeof FRAMEWORK_CONFIGS[string],
  layoutComponents: string[],
): ComponentMapping[] {
  return componentNames.map((name) => {
    const targetDir = `${config.componentBaseDir}/${name}`;
    const mainFile = `${targetDir}/${name}${config.componentExt}`;
    const relatedFiles: string[] = [`${targetDir}/index.ts`];

    // 如果是 React + css-modules，加上样式文件
    if (fwKey === 'react') {
      relatedFiles.push(`${targetDir}/${name}.module.css`);
    }

    // 计算导入路径（从 src/ 出发的相对路径）
    const importPath = fwKey === 'html+css+js'
      ? `./${config.componentBaseDir}/${name}`
      : `./${config.componentBaseDir.replace('src/', '')}/${name}`;

    return {
      componentName: name,
      targetPath: mainFile,
      targetDir,
      relatedFiles,
      importPath,
      isLayout: layoutComponents.includes(name),
    };
  });
}

function buildConfigFiles(
  fwKey: string,
  projectName: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  scripts: Record<string, string>,
  styleMethod: string,
): ProjectFileEntry[] {
  const files: ProjectFileEntry[] = [];

  // package.json
  const pkg = {
    name: projectName,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts,
    dependencies,
    devDependencies,
  };
  files.push({
    filePath: 'package.json',
    role: 'config',
    description: '项目依赖和脚本配置',
    generatedBy: 'template',
    templateContent: JSON.stringify(pkg, null, 2),
  });

  // tsconfig.json (非原生项目)
  if (fwKey !== 'html+css+js') {
    const tsconfig: Record<string, any> = {
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        module: 'ESNext',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        isolatedModules: true,
        moduleDetection: 'force',
        noEmit: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ['src'],
    };
    if (fwKey === 'react') {
      tsconfig.compilerOptions.jsx = 'react-jsx';
    }
    files.push({
      filePath: 'tsconfig.json',
      role: 'config',
      description: 'TypeScript 配置',
      generatedBy: 'template',
      templateContent: JSON.stringify(tsconfig, null, 2),
    });
  }

  // vite.config (非原生项目)
  if (fwKey !== 'html+css+js') {
    const imports: string[] = [`import { defineConfig } from 'vite';`];
    const plugins: string[] = [];

    if (fwKey === 'react') {
      imports.push(`import react from '@vitejs/plugin-react';`);
      plugins.push('react()');
    } else if (fwKey === 'vue') {
      imports.push(`import vue from '@vitejs/plugin-vue';`);
      plugins.push('vue()');
    }

    if (styleMethod === 'tailwind') {
      imports.push(`import tailwindcss from '@tailwindcss/vite';`);
      plugins.push('tailwindcss()');
    }

    files.push({
      filePath: 'vite.config.ts',
      role: 'config',
      description: 'Vite 构建配置',
      generatedBy: 'template',
      templateContent: `${imports.join('\n')}\n\nexport default defineConfig({\n  plugins: [${plugins.join(', ')}],\n});\n`,
    });
  }

  // .gitignore
  files.push({
    filePath: '.gitignore',
    role: 'config',
    description: 'Git 忽略规则',
    generatedBy: 'template',
    templateContent: `node_modules/\ndist/\nbuild/\n.cache/\n.env\n.env.local\n.DS_Store\n*.log\n`,
  });

  return files;
}

// ── Agent 主函数 ──────────────────────────────────

export async function runProjectPlanner(
  requirement: string,
  designOutput: DesignOutput,
  providers: AllProviders,
  options: {
    framework: string;
    styleMethod?: string;
    packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
    darkMode?: boolean;
    projectName?: string;
  },
): Promise<ProjectPlannerResult> {
  const {
    framework,
    styleMethod = 'tailwind',
    packageManager = 'pnpm',
    darkMode = false,
    projectName: explicitName,
  } = options;

  const fwKey = normalizeFrameworkKey(framework);
  const config = FRAMEWORK_CONFIGS[fwKey] ?? FRAMEWORK_CONFIGS.react;
  const tiersUsed: string[] = [];

  console.log('\n📐 [Project Planner] 开始规划项目结构...');
  console.log(`   框架：${fwKey}`);
  console.log(`   样式：${styleMethod}`);
  console.log(`   组件数：${designOutput.componentTree.length}`);

  // ── Step 1: 用 LLM 补充智能规划 ──

  const componentNames = designOutput.componentTree.map((c) => c.name);

  tiersUsed.push('worker');
  const planStream = streamText({
    model: getWrappedModel('worker', providers),
    system: `你是一个资深前端项目架构师。根据需求和组件列表，补充项目规划细节。

你需要判断：
1. 推荐一个合适的项目名（kebab-case）
2. 除了标准目录外是否需要额外目录（如 src/api/, src/stores/, src/pages/）
3. 是否需要额外的文件（如路由配置、全局 store、API 封装）
4. 哪些组件是布局组件（如 NavBar, Header, Footer, Sidebar, Layout）
5. 是否需要额外的功能特性（router, state-management, animation, form-validation, http-client 等）
6. 额外需要的 npm 依赖

框架：${fwKey}
样式方案：${styleMethod}
组件列表：${componentNames.join(', ')}
${fwKey === 'html+css+js' ? '\n注意：这是原生 HTML/CSS/JS 项目，组件会被合并到 index.html + styles/main.css + scripts/main.js 三个文件中。不需要额外目录（additionalDirectories 应为空数组 []），不需要路由/状态管理等框架功能。保持简单。' : ''}

你必须输出合法的 JSON，格式如下：
{
  "projectName": "my-login-page",
  "additionalDirectories": ["src/api", "src/stores"],
  "additionalFiles": [
    {"filePath": "src/api/auth.ts", "role": "util", "description": "认证 API 封装"}
  ],
  "layoutComponents": ["NavBar", "Footer"],
  "features": ["router", "state-management"],
  "notes": ["建议使用 Zustand 管理登录状态", "NavBar 和 Footer 应作为布局组件"],
  "additionalDependencies": {"axios": "^1.7.0"},
  "additionalDevDependencies": {}
}

不要输出任何 JSON 以外的内容。`,
    prompt: `需求：${requirement}

组件树详情：
${designOutput.componentTree.map((c) => `- ${c.name}: ${c.description}`).join('\n')}

响应式策略：${designOutput.responsiveStrategy.approach}
状态管理建议：${designOutput.stateDesign.recommendation}
共享状态：${designOutput.stateDesign.sharedStates.join(', ') || '无'}`,
    temperature: 0.3,
    maxOutputTokens: 4000,
    experimental_telemetry: telemetryConfig('project-planner:plan'),
  });

  const planText = await consumeTextStream(planStream.textStream, { prefix: '      [plan] ', echo: false });

  let aiPlan: z.infer<typeof AiPlanningResultSchema>;
  try {
    const raw = safeParseJson(planText);
    const parsed = AiPlanningResultSchema.safeParse(raw);
    aiPlan = parsed.success ? parsed.data : {
      projectName: undefined,
      additionalDirectories: [],
      additionalFiles: [],
      layoutComponents: [],
      features: [],
      notes: [planText.slice(0, 300)],
      additionalDependencies: {},
      additionalDevDependencies: {},
    };
  } catch {
    console.warn('   ⚠️  AI 规划解析失败，使用默认配置');
    aiPlan = {
      additionalDirectories: [],
      additionalFiles: [],
      layoutComponents: [],
      features: [],
      notes: ['AI 规划解析失败，使用框架默认结构'],
      additionalDependencies: {},
      additionalDevDependencies: {},
    };
  }

  // ── Step 2: 合并规划结果 ──

  const projectName = explicitName ?? aiPlan.projectName ?? 'my-app';

  // 目录
  let directories: string[];
  if (fwKey === 'html+css+js') {
    // 原生项目只需要 styles/ 和 scripts/，组件会合并到 3 个文件里
    directories = [...config.directories];
  } else {
    directories = [...new Set([
      ...config.directories,
      ...aiPlan.additionalDirectories,
      ...componentNames.map((name) => `${config.componentBaseDir}/${name}`),
    ])];
  }

  // 依赖
  const styleDeps = STYLE_DEPS[styleMethod] ?? { deps: {}, devDeps: {} };
  const dependencies: Record<string, string> = {
    ...config.defaultDeps,
    ...styleDeps.deps,
    ...aiPlan.additionalDependencies,
  };
  const devDependencies: Record<string, string> = {
    ...config.defaultDevDeps,
    ...styleDeps.devDeps,
    ...aiPlan.additionalDevDependencies,
  };

  // 组件映射
  const componentMapping = buildComponentMapping(
    componentNames,
    fwKey,
    config,
    aiPlan.layoutComponents,
  );

  // 配置文件
  const configFiles = buildConfigFiles(
    fwKey,
    projectName,
    dependencies,
    devDependencies,
    config.defaultScripts,
    styleMethod,
  );

  // 入口文件条目
  const entryFiles: ProjectFileEntry[] = config.entryFiles.map((ef) => ({
    filePath: ef.path,
    role: ef.role,
    description: `${fwKey} 标准入口文件`,
    generatedBy: 'template' as const,
  }));

  // 组件文件条目
  const componentFiles: ProjectFileEntry[] = componentMapping.flatMap((cm) => [
    {
      filePath: cm.targetPath,
      role: 'component' as const,
      description: `${cm.componentName} 组件主文件`,
      generatedBy: 'ai' as const,
    },
    ...cm.relatedFiles.map((rf) => ({
      filePath: rf,
      role: (rf.endsWith('.css') ? 'style' : 'component') as ProjectFileEntry['role'],
      description: `${cm.componentName} 关联文件`,
      generatedBy: 'ai' as const,
    })),
  ]);

  // AI 建议的额外文件
  const additionalFiles: ProjectFileEntry[] = aiPlan.additionalFiles.map((f) => ({
    filePath: f.filePath,
    role: (f.role as ProjectFileEntry['role']) || 'util',
    description: f.description,
    generatedBy: 'ai' as const,
  }));

  // barrel 文件
  const barrelFile: ProjectFileEntry = {
    filePath: `${config.componentBaseDir}/index.ts`,
    role: 'component',
    description: '组件 barrel re-export 文件',
    generatedBy: 'template',
  };

  const allFiles = [...configFiles, ...entryFiles, ...(fwKey !== 'html+css+js' ? [barrelFile] : []), ...componentFiles, ...additionalFiles];

  // 包管理器命令
  const installCmd = { npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn', bun: 'bun install' }[packageManager];
  const devCmd = packageManager === 'npm' ? 'npm run dev' : `${packageManager} dev`;
  const buildCmd = packageManager === 'npm' ? 'npm run build' : `${packageManager} build`;

  // 脚手架命令
  const setupCommands: string[] = [];
  if (fwKey !== 'html+css+js') {
    setupCommands.push(`mkdir -p ${projectName} && cd ${projectName}`);
    setupCommands.push(installCmd);
  }

  const structure: ProjectStructure = {
    projectName,
    framework: fwKey,
    styleMethod,
    packageManager,
    directories,
    files: allFiles,
    dependencies,
    devDependencies,
    scripts: config.defaultScripts,
    componentMapping,
    setupCommands,
    installCommand: installCmd,
    devCommand: devCmd,
    buildCommand: buildCmd,
    notes: aiPlan.notes,
  };

  // ── 日志输出 ──

  console.log(`   ✅ 项目规划完成`);
  console.log(`   📦 项目名：${projectName}`);
  console.log(`   📂 目录数：${directories.length}`);
  console.log(`   📄 文件数：${allFiles.length}`);
  console.log(`   🧩 组件数：${componentMapping.length}`);
  console.log(`   📦 依赖数：${Object.keys(dependencies).length} + ${Object.keys(devDependencies).length} (dev)`);

  if (aiPlan.layoutComponents.length > 0) {
    console.log(`   🏗️  布局组件：${aiPlan.layoutComponents.join(', ')}`);
  }
  if (aiPlan.features.length > 0) {
    console.log(`   ⚡ 功能特性：${aiPlan.features.join(', ')}`);
  }
  if (aiPlan.notes.length > 0) {
    for (const note of aiPlan.notes) {
      console.log(`   💡 ${note}`);
    }
  }

  console.log(`\n📐 [Project Planner] 规划完成！\n`);

  return {
    structure,
    aiNotes: aiPlan.notes,
    modelTiersUsed: tiersUsed,
  };
}
