/**
 * @file tools/project/index.ts — 项目规划工具集
 *
 * 本文件定义了 Project Planner Agent 使用的项目结构规划工具。
 * 核心思想是将项目搭建知识（目录结构、依赖版本、配置模板）预编码为静态映射表，
 * AI Agent 只需选择框架和特性，即可获得完整的项目骨架方案。
 *
 * 在 Cheater Pipeline 中的位置：
 *   需求精炼 → 设计分析 → **项目规划** → 代码生成 → 代码审计 → 代码组装
 *
 * 提供的工具：
 *   1. planProjectStructure    — 根据框架和组件列表规划目录结构
 *   2. generateConfigFile      — 生成 package.json / tsconfig / vite.config 等配置文件
 *   3. inferDependencies       — 根据框架 + 样式 + 特性推断 npm 依赖清单
 *   4. generateScaffoldCommands — 生成项目初始化脚手架命令（npm/pnpm/yarn/bun）
 *
 * 内部数据结构：
 *   - FRAMEWORK_STRUCTURES     — 框架标准目录模板（React / Vue / Svelte / Vanilla）
 *   - FRAMEWORK_DEPENDENCIES   — 框架核心依赖及版本映射
 *   - STYLE_DEPENDENCIES       — 样式方案依赖映射（Tailwind / Sass / styled-components 等）
 *   - FEATURE_DEPENDENCIES     — 功能特性依赖映射（路由、状态管理、动画、测试等）
 *
 * 所有工具均为纯计算逻辑，不依赖 LLM，可零成本调用。
 */

import { tool } from 'ai';
import { z } from 'zod';

// ── 框架标准目录模板 ──────────────────────────────
// 以下映射表预定义了各框架的推荐目录结构和入口文件列表。

/**
 * 预定义的框架目录结构模板。
 *
 * 包含 React / Vue / Svelte / 原生 HTML 四种方案，
 * 每个框架定义了推荐的目录列表和入口文件路径。
 * 设计参考了社区最佳实践和官方模板（Vite / SvelteKit 等），
 * 确保生成的项目结构合理且符合开发者习惯。
 */
const FRAMEWORK_STRUCTURES: Record<
  string,
  {
    directories: string[];
    entryFiles: Array<{ path: string; role: string }>;
  }
> = {
  react: {
    directories: [
      'src',
      'src/components',
      'src/pages',
      'src/hooks',
      'src/styles',
      'src/types',
      'src/utils',
      'src/assets',
      'public',
    ],
    entryFiles: [
      { path: 'src/main.tsx', role: 'entry' },
      { path: 'src/App.tsx', role: 'entry' },
      { path: 'index.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
  },
  vue: {
    directories: [
      'src',
      'src/components',
      'src/views',
      'src/composables',
      'src/stores',
      'src/styles',
      'src/types',
      'src/utils',
      'src/assets',
      'public',
    ],
    entryFiles: [
      { path: 'src/main.ts', role: 'entry' },
      { path: 'src/App.vue', role: 'entry' },
      { path: 'index.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
  },
  svelte: {
    directories: [
      'src',
      'src/lib',
      'src/lib/components',
      'src/lib/stores',
      'src/lib/utils',
      'src/lib/types',
      'src/routes',
      'src/styles',
      'static',
    ],
    entryFiles: [
      { path: 'src/routes/+page.svelte', role: 'entry' },
      { path: 'src/routes/+layout.svelte', role: 'entry' },
      { path: 'src/app.html', role: 'entry' },
      { path: 'src/styles/globals.css', role: 'style' },
    ],
  },
  'html+css+js': {
    directories: ['components', 'styles', 'scripts', 'assets', 'assets/images', 'assets/fonts'],
    entryFiles: [
      { path: 'index.html', role: 'entry' },
      { path: 'styles/main.css', role: 'style' },
      { path: 'scripts/main.js', role: 'script' },
    ],
  },
};

// ── 依赖映射表 ──────────────────────────────────
// 以下三个映射表分别定义了框架、样式方案和功能特性的 npm 依赖。
// Project Planner 根据用户需求查表合并，无需 LLM 推断。

/**
 * 预定义的框架核心依赖映射表。
 *
 * 按框架分类列出必要的 dependencies 和 devDependencies，
 * 包含推荐的版本号（使用 ^ 范围语义化版本）。
 */
const FRAMEWORK_DEPENDENCIES: Record<
  string,
  {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }
> = {
  react: {
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      '@vitejs/plugin-react': '^4.4.0',
      typescript: '^5.7.0',
      vite: '^6.0.0',
    },
  },
  vue: {
    dependencies: {
      vue: '^3.5.0',
    },
    devDependencies: {
      '@vitejs/plugin-vue': '^5.2.0',
      typescript: '^5.7.0',
      'vue-tsc': '^2.2.0',
      vite: '^6.0.0',
    },
  },
  svelte: {
    dependencies: {},
    devDependencies: {
      '@sveltejs/adapter-auto': '^4.0.0',
      '@sveltejs/kit': '^2.15.0',
      svelte: '^5.0.0',
      typescript: '^5.7.0',
      vite: '^6.0.0',
    },
  },
  'html+css+js': {
    dependencies: {},
    devDependencies: {},
  },
};

/**
 * 预定义的样式方案依赖映射表。
 *
 * 按样式方案分类列出额外需要的 npm 包，
 * 如 Tailwind CSS、Sass、styled-components 等。
 * CSS 和 CSS Modules 不需要额外依赖（内置于 Vite）。
 */
const STYLE_DEPENDENCIES: Record<
  string,
  {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }
> = {
  tailwind: {
    dependencies: {},
    devDependencies: {
      tailwindcss: '^4.0.0',
      '@tailwindcss/vite': '^4.0.0',
    },
  },
  'css-modules': {
    dependencies: {},
    devDependencies: {},
  },
  css: {
    dependencies: {},
    devDependencies: {},
  },
  sass: {
    dependencies: {},
    devDependencies: {
      sass: '^1.80.0',
    },
  },
  'styled-components': {
    dependencies: {
      'styled-components': '^6.1.0',
    },
    devDependencies: {
      '@types/styled-components': '^5.1.34',
    },
  },
};

/**
 * 预定义的功能特性依赖映射表。
 *
 * 按功能需求分类列出额外的 npm 包和可能需要的目录。
 * 支持的特性：路由、状态管理、动画、表单验证、图标库、HTTP 客户端、测试框架等。
 * 部分特性还附带推荐的目录结构（如 router → src/pages）。
 */
const FEATURE_DEPENDENCIES: Record<
  string,
  {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    directories?: string[];
  }
> = {
  router: {
    dependencies: { 'react-router-dom': '^7.0.0' },
    devDependencies: {},
    directories: ['src/pages'],
  },
  'vue-router': {
    dependencies: { 'vue-router': '^4.5.0' },
    devDependencies: {},
    directories: ['src/views'],
  },
  'state-management': {
    dependencies: { zustand: '^5.0.0' },
    devDependencies: {},
    directories: ['src/stores'],
  },
  pinia: {
    dependencies: { pinia: '^2.3.0' },
    devDependencies: {},
    directories: ['src/stores'],
  },
  animation: {
    dependencies: { 'framer-motion': '^12.0.0' },
    devDependencies: {},
  },
  'form-validation': {
    dependencies: { zod: '^3.24.0', 'react-hook-form': '^7.54.0', '@hookform/resolvers': '^3.9.0' },
    devDependencies: {},
  },
  'icon-library': {
    dependencies: { 'lucide-react': '^0.468.0' },
    devDependencies: {},
  },
  'http-client': {
    dependencies: { axios: '^1.7.0' },
    devDependencies: {},
    directories: ['src/api'],
  },
  testing: {
    dependencies: {},
    devDependencies: {
      vitest: '^2.1.0',
      '@testing-library/react': '^16.1.0',
      '@testing-library/jest-dom': '^6.6.0',
    },
    directories: ['src/__tests__'],
  },
};

// ── 配置文件模板生成器 ──────────────────────────────
// 以下函数生成各类项目配置文件的文本内容。

/**
 * 生成 package.json 文件内容。
 *
 * 合并框架默认脚本、用户自定义脚本、生产依赖和开发依赖。
 * 输出格式化的 JSON 字符串（2 空格缩进）。
 *
 * @param opts - 项目名、框架、依赖、脚本等配置选项
 * @returns package.json 的 JSON 字符串
 */
function generatePackageJson(opts: {
  projectName: string;
  framework: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts?: Record<string, string>;
}): string {
  // 各框架的默认 npm scripts
  const defaultScripts: Record<string, Record<string, string>> = {
    react: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
    vue: { dev: 'vite', build: 'vue-tsc -b && vite build', preview: 'vite preview' },
    svelte: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
    'html+css+js': { dev: 'npx serve .', build: 'echo "No build step needed"' },
  };

  const pkg = {
    name: opts.projectName,
    private: true,
    version: '0.0.0',
    type: 'module' as const,
    scripts: opts.scripts ?? defaultScripts[opts.framework] ?? defaultScripts.react,
    dependencies: opts.dependencies,
    devDependencies: opts.devDependencies,
  };

  return JSON.stringify(pkg, null, 2);
}

/** tsconfig.json 的 compilerOptions 类型定义 */
interface TsconfigCompilerOptions {
  target: string;
  useDefineForClassFields: boolean;
  module: string;
  lib: string[];
  skipLibCheck: boolean;
  moduleResolution: string;
  allowImportingTsExtensions: boolean;
  isolatedModules: boolean;
  moduleDetection: string;
  noEmit: boolean;
  strict: boolean;
  noUnusedLocals: boolean;
  noUnusedParameters: boolean;
  noFallthroughCasesInSwitch: boolean;
  noUncheckedSideEffectImports: boolean;
  jsx?: string;
}

/** tsconfig.json 的完整结构类型定义 */
interface TsconfigJson {
  compilerOptions: TsconfigCompilerOptions;
  include: string[];
}

/**
 * 生成 tsconfig.json 文件内容。
 * 基础配置适配 ES2020 + Bundler 模块解析 + 严格模式。
 * React 框架额外启用 jsx: 'react-jsx'。
 *
 * @param framework - 目标框架名
 * @returns tsconfig.json 的 JSON 字符串
 */
function generateTsconfigJson(framework: string): string {
  const base: TsconfigJson = {
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
      noUncheckedSideEffectImports: true,
    },
    include: ['src'],
  };

  if (framework === 'react') {
    base.compilerOptions.jsx = 'react-jsx';
  }

  return JSON.stringify(base, null, 2);
}

/**
 * 生成 vite.config.ts 文件内容。
 * 根据框架和样式方案动态添加对应的 Vite 插件。
 *
 * @param framework - 目标框架（react / vue）
 * @param styleMethod - 样式方案（如 tailwind 时会添加 @tailwindcss/vite 插件）
 * @returns vite.config.ts 的源代码字符串
 */
function generateViteConfig(framework: string, styleMethod: string): string {
  const plugins: string[] = [];  // Vite 插件调用表达式列表
  const imports: string[] = [`import { defineConfig } from 'vite';`];  // import 语句列表

  if (framework === 'react') {
    imports.push(`import react from '@vitejs/plugin-react';`);
    plugins.push('react()');
  } else if (framework === 'vue') {
    imports.push(`import vue from '@vitejs/plugin-vue';`);
    plugins.push('vue()');
  }

  if (styleMethod === 'tailwind') {
    imports.push(`import tailwindcss from '@tailwindcss/vite';`);
    plugins.push('tailwindcss()');
  }

  return `${imports.join('\n')}

export default defineConfig({
  plugins: [${plugins.join(', ')}],
});
`;
}

/**
 * 生成 .gitignore 文件内容。
 * 包含 node_modules、构建产物、环境变量、编辑器配置、系统文件等常见忽略规则。
 * @returns .gitignore 文件的文本内容
 */
function generateGitignore(): string {
  return `# dependencies
node_modules/
.pnp
.pnp.js

# build
dist/
build/
.cache/

# env
.env
.env.local
.env.*.local

# editor
.vscode/
.idea/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# logs
*.log
npm-debug.log*
`;
}

// ── AI SDK 工具定义 ──────────────────────────────────

/**
 * planProjectStructure — 根据框架和组件列表规划完整的项目目录结构。
 *
 * 基于预定义的框架模板，结合用户指定的组件列表、路由需求、状态管理需求等，
 * 生成完整的目录列表和文件清单。
 *
 * @param framework - 目标框架（react / vue / svelte / html+css+js）
 * @param components - 组件名列表（PascalCase）
 * @param hasRouter - 是否需要路由（默认 false）
 * @param hasStateManagement - 是否需要全局状态管理（默认 false）
 * @param styleMethod - 样式方案（默认 'tailwind'）
 * @param features - 额外功能需求列表
 * @returns 目录列表、入口文件、组件条目和功能特性清单
 */
export const planProjectStructure = tool({
  description: '根据框架和组件列表规划完整的项目目录结构，返回目录树和文件清单',
  inputSchema: z.object({
    framework: z.string().describe('目标框架：react, vue, svelte, html+css+js'),
    components: z.array(z.string()).describe('组件名列表（PascalCase）'),
    hasRouter: z.boolean().default(false).describe('是否需要路由'),
    hasStateManagement: z.boolean().default(false).describe('是否需要全局状态管理'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    features: z
      .array(z.string())
      .optional()
      .default([])
      .describe('额外功能需求：animation, form-validation, http-client 等'),
  }),
  execute: async ({
    framework,
    components,
    hasRouter,
    hasStateManagement,
    styleMethod,
    features,
  }) => {
    // 标准化框架名称
    const fwKey = framework.toLowerCase().includes('html')
      ? 'html+css+js'
      : framework.toLowerCase();
    // 获取框架对应的目录模板，找不到则回退到 React
    const structure = FRAMEWORK_STRUCTURES[fwKey] ?? FRAMEWORK_STRUCTURES.react;

    const directories = [...structure.directories];
    const componentEntries: Array<{ component: string; directory: string; files: string[] }> = [];

    // 组件目录规划 —— 不同框架的组件存放位置不同
    const componentBaseDir =
      fwKey === 'html+css+js'
        ? 'components'
        : fwKey === 'svelte'
          ? 'src/lib/components'
          : 'src/components';

    for (const name of components) {
      const dir = `${componentBaseDir}/${name}`;
      directories.push(dir);

      const files: string[] = [];
      if (fwKey === 'react') {
        files.push(`${dir}/${name}.tsx`, `${dir}/index.ts`);
        if (styleMethod === 'css-modules') files.push(`${dir}/${name}.module.css`);
      } else if (fwKey === 'vue') {
        files.push(`${dir}/${name}.vue`, `${dir}/index.ts`);
      } else if (fwKey === 'svelte') {
        files.push(`${dir}/${name}.svelte`, `${dir}/index.ts`);
      } else {
        files.push(`${dir}/${name}.html`, `${dir}/${name}.css`, `${dir}/${name}.js`);
      }

      componentEntries.push({ component: name, directory: dir, files });
    }

    // 功能目录 —— 根据选定的功能特性追加额外目录和依赖
    const allFeatures = [...(features ?? [])];
    // 自动将 hasRouter/hasStateManagement 转换为对应的功能特性名
    if (hasRouter) allFeatures.push(fwKey === 'vue' ? 'vue-router' : 'router');
    if (hasStateManagement) allFeatures.push(fwKey === 'vue' ? 'pinia' : 'state-management');

    for (const feat of allFeatures) {
      const featureDep = FEATURE_DEPENDENCIES[feat];
      if (featureDep?.directories) {
        directories.push(...featureDep.directories);
      }
    }

    return {
      framework: fwKey,
      // 使用 Set 去重（可能有重复目录）
      directories: [...new Set(directories)],
      entryFiles: structure.entryFiles,
      componentEntries,
      features: allFeatures,
      instruction: `已为 ${fwKey} 框架规划项目结构：${directories.length} 个目录，${components.length} 个组件，${allFeatures.length} 个特性模块。`,
    };
  },
});

/**
 * generateConfigFile — 生成项目配置文件内容。
 *
 * 根据配置文件类型调用对应的模板生成器，生成文件内容。
 * 支持的配置文件类型：
 *   - package.json：合并框架依赖 + 样式依赖 + 用户自定义依赖
 *   - tsconfig.json：框架相关的 TypeScript 配置
 *   - vite.config：Vite 构建配置（含框架和样式插件）
 *   - gitignore：标准 .gitignore 模板
 *
 * @param configType - 配置文件类型
 * @param framework - 目标框架
 * @param projectName - 项目名（默认 'my-app'）
 * @param styleMethod - 样式方案（默认 'tailwind'）
 * @param dependencies - 额外生产依赖（可选）
 * @param devDependencies - 额外开发依赖（可选）
 * @param scripts - 自定义 npm scripts（可选）
 * @returns 文件名和文件内容
 */
export const generateConfigFile = tool({
  description: '生成项目配置文件内容（package.json, tsconfig.json, vite.config.ts, .gitignore 等）',
  inputSchema: z.object({
    configType: z
      .enum(['package.json', 'tsconfig.json', 'vite.config', 'gitignore'])
      .describe('配置文件类型'),
    framework: z.string().describe('目标框架'),
    projectName: z.string().default('my-app').describe('项目名'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    dependencies: z.record(z.string()).optional().describe('额外生产依赖'),
    devDependencies: z.record(z.string()).optional().describe('额外开发依赖'),
    scripts: z.record(z.string()).optional().describe('自定义 npm scripts'),
  }),
  execute: async ({
    configType,
    framework,
    projectName,
    styleMethod,
    dependencies,
    devDependencies,
    scripts,
  }) => {
    // 标准化框架名称
    const fwKey = framework.toLowerCase().includes('html')
      ? 'html+css+js'
      : framework.toLowerCase();

    // 根据配置文件类型分发到对应的生成器
    switch (configType) {
      case 'package.json': {
        // 合并框架依赖 + 样式依赖 + 用户自定义依赖
        const fwDeps = FRAMEWORK_DEPENDENCIES[fwKey] ?? { dependencies: {}, devDependencies: {} };
        const styleDeps = STYLE_DEPENDENCIES[styleMethod] ?? {
          dependencies: {},
          devDependencies: {},
        };
        return {
          fileName: 'package.json',
          content: generatePackageJson({
            projectName,
            framework: fwKey,
            dependencies: {
              ...fwDeps.dependencies,
              ...styleDeps.dependencies,
              ...(dependencies ?? {}),
            },
            devDependencies: {
              ...fwDeps.devDependencies,
              ...styleDeps.devDependencies,
              ...(devDependencies ?? {}),
            },
            scripts,
          }),
        };
      }
      case 'tsconfig.json':
        return {
          fileName: 'tsconfig.json',
          content: generateTsconfigJson(fwKey),
        };
      case 'vite.config':
        return {
          fileName: fwKey === 'vue' ? 'vite.config.ts' : 'vite.config.ts',
          content: generateViteConfig(fwKey, styleMethod),
        };
      case 'gitignore':
        return {
          fileName: '.gitignore',
          content: generateGitignore(),
        };
      default:
        return { fileName: configType, content: '' };
    }
  },
});

/**
 * inferDependencies — 根据框架、样式方案和功能特性推断完整的 npm 依赖清单。
 *
 * 查表合并所有相关依赖，输出统一的 dependencies 和 devDependencies 映射。
 * 纯计算逻辑，零 LLM 成本。
 *
 * @param framework - 目标框架
 * @param styleMethod - 样式方案（默认 'tailwind'）
 * @param features - 额外功能特性列表
 * @returns 生产依赖、开发依赖和总包数统计
 */
export const inferDependencies = tool({
  description: '根据框架、样式方案和功能特性推断完整的 npm 依赖清单',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    features: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        '额外功能：router, state-management, animation, form-validation, icon-library, http-client, testing',
      ),
  }),
  execute: async ({ framework, styleMethod, features }) => {
    const fwKey = framework.toLowerCase().includes('html')
      ? 'html+css+js'
      : framework.toLowerCase();
    const fwDeps = FRAMEWORK_DEPENDENCIES[fwKey] ?? { dependencies: {}, devDependencies: {} };
    const styleDeps = STYLE_DEPENDENCIES[styleMethod] ?? { dependencies: {}, devDependencies: {} };

    const allDeps: Record<string, string> = { ...fwDeps.dependencies, ...styleDeps.dependencies };
    const allDevDeps: Record<string, string> = {
      ...fwDeps.devDependencies,
      ...styleDeps.devDependencies,
    };

    for (const feat of features ?? []) {
      const featureDep = FEATURE_DEPENDENCIES[feat];
      if (featureDep) {
        Object.assign(allDeps, featureDep.dependencies);
        Object.assign(allDevDeps, featureDep.devDependencies);
      }
    }

    return {
      dependencies: allDeps,
      devDependencies: allDevDeps,
      totalPackages: Object.keys(allDeps).length + Object.keys(allDevDeps).length,
      summary: `生产依赖 ${Object.keys(allDeps).length} 个，开发依赖 ${Object.keys(allDevDeps).length} 个`,
    };
  },
});

/**
 * generateScaffoldCommands — 生成项目初始化脚手架命令。
 *
 * 根据框架和包管理器生成完整的项目创建和初始化命令序列。
 * 支持 npm / pnpm / yarn / bun 四种包管理器。
 *
 * @param framework - 目标框架
 * @param packageManager - 包管理器（默认 'pnpm'）
 * @param projectName - 项目名（默认 'my-app'）
 * @param typescript - 是否使用 TypeScript（默认 true）
 * @returns 命令列表、安装命令、开发命令和构建命令
 */
export const generateScaffoldCommands = tool({
  description: '生成项目初始化脚手架命令（npm create, pnpm create 等）',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('pnpm').describe('包管理器'),
    projectName: z.string().default('my-app').describe('项目名'),
    typescript: z.boolean().default(true).describe('是否使用 TypeScript'),
  }),
  execute: async ({ framework, packageManager, projectName, typescript }) => {
    const fwKey = framework.toLowerCase().includes('html')
      ? 'html+css+js'
      : framework.toLowerCase();
    const commands: Array<{ command: string; description: string; optional: boolean }> = [];

    // 各包管理器的 install 命令
    const installCmd = {
      npm: 'npm install',
      pnpm: 'pnpm install',
      yarn: 'yarn',
      bun: 'bun install',
    }[packageManager];

    // 各包管理器的 create 命令前缀
    const createPrefix = {
      npm: 'npm create',
      pnpm: 'pnpm create',
      yarn: 'yarn create',
      bun: 'bun create',
    }[packageManager];

    if (fwKey === 'react') {
      commands.push({
        command: `${createPrefix} vite@latest ${projectName} -- --template react${typescript ? '-ts' : ''}`,
        description: '使用 Vite 创建 React 项目',
        optional: false,
      });
    } else if (fwKey === 'vue') {
      commands.push({
        command: `${createPrefix} vue@latest ${projectName}`,
        description: '使用 create-vue 创建 Vue 项目',
        optional: false,
      });
    } else if (fwKey === 'svelte') {
      commands.push({
        command: `${createPrefix} svelte@latest ${projectName}`,
        description: '使用 create-svelte 创建 SvelteKit 项目',
        optional: false,
      });
    } else {
      commands.push({
        command: `mkdir -p ${projectName} && cd ${projectName}`,
        description: '创建项目目录（原生 HTML+CSS+JS 无需脚手架）',
        optional: false,
      });
    }

    commands.push({
      command: `cd ${projectName} && ${installCmd}`,
      description: '安装依赖',
      optional: false,
    });

    return {
      packageManager,
      commands,
      installCommand: installCmd,
      devCommand: packageManager === 'npm' ? 'npm run dev' : `${packageManager} dev`,
      buildCommand: packageManager === 'npm' ? 'npm run build' : `${packageManager} build`,
    };
  },
});
