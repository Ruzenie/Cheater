/**
 * tools/project/index.ts — 项目规划工具集
 *
 * 为 Project Planner Agent 提供的工具：
 *   1. planProjectStructure — 根据框架规划目录结构
 *   2. generateConfigFile   — 生成配置文件内容
 *   3. inferDependencies    — 推断依赖清单
 *   4. generateScaffoldCommands — 生成脚手架指令
 */

import { tool } from 'ai';
import { z } from 'zod';

// ── 框架标准目录模板 ──────────────────────────────

const FRAMEWORK_STRUCTURES: Record<string, {
  directories: string[];
  entryFiles: Array<{ path: string; role: string }>;
}> = {
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
    directories: [
      'components',
      'styles',
      'scripts',
      'assets',
      'assets/images',
      'assets/fonts',
    ],
    entryFiles: [
      { path: 'index.html', role: 'entry' },
      { path: 'styles/main.css', role: 'style' },
      { path: 'scripts/main.js', role: 'script' },
    ],
  },
};

// ── 依赖映射表 ──────────────────────────────────

const FRAMEWORK_DEPENDENCIES: Record<string, {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}> = {
  react: {
    dependencies: {
      'react': '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      '@vitejs/plugin-react': '^4.4.0',
      'typescript': '^5.7.0',
      'vite': '^6.0.0',
    },
  },
  vue: {
    dependencies: {
      'vue': '^3.5.0',
    },
    devDependencies: {
      '@vitejs/plugin-vue': '^5.2.0',
      'typescript': '^5.7.0',
      'vue-tsc': '^2.2.0',
      'vite': '^6.0.0',
    },
  },
  svelte: {
    dependencies: {},
    devDependencies: {
      '@sveltejs/adapter-auto': '^4.0.0',
      '@sveltejs/kit': '^2.15.0',
      'svelte': '^5.0.0',
      'typescript': '^5.7.0',
      'vite': '^6.0.0',
    },
  },
  'html+css+js': {
    dependencies: {},
    devDependencies: {},
  },
};

const STYLE_DEPENDENCIES: Record<string, {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}> = {
  tailwind: {
    dependencies: {},
    devDependencies: {
      'tailwindcss': '^4.0.0',
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
      'sass': '^1.80.0',
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

const FEATURE_DEPENDENCIES: Record<string, {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  directories?: string[];
}> = {
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
    dependencies: { 'zustand': '^5.0.0' },
    devDependencies: {},
    directories: ['src/stores'],
  },
  pinia: {
    dependencies: { 'pinia': '^2.3.0' },
    devDependencies: {},
    directories: ['src/stores'],
  },
  animation: {
    dependencies: { 'framer-motion': '^12.0.0' },
    devDependencies: {},
  },
  'form-validation': {
    dependencies: { 'zod': '^3.24.0', 'react-hook-form': '^7.54.0', '@hookform/resolvers': '^3.9.0' },
    devDependencies: {},
  },
  'icon-library': {
    dependencies: { 'lucide-react': '^0.468.0' },
    devDependencies: {},
  },
  'http-client': {
    dependencies: { 'axios': '^1.7.0' },
    devDependencies: {},
    directories: ['src/api'],
  },
  testing: {
    dependencies: {},
    devDependencies: {
      'vitest': '^2.1.0',
      '@testing-library/react': '^16.1.0',
      '@testing-library/jest-dom': '^6.6.0',
    },
    directories: ['src/__tests__'],
  },
};

// ── 配置文件模板 ──────────────────────────────────

function generatePackageJson(opts: {
  projectName: string;
  framework: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts?: Record<string, string>;
}): string {
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

function generateTsconfigJson(framework: string): string {
  const base: Record<string, any> = {
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

function generateViteConfig(framework: string, styleMethod: string): string {
  const plugins: string[] = [];
  const imports: string[] = [`import { defineConfig } from 'vite';`];

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

// ── 工具定义 ──────────────────────────────────────

export const planProjectStructure = tool({
  description: '根据框架和组件列表规划完整的项目目录结构，返回目录树和文件清单',
  inputSchema: z.object({
    framework: z.string().describe('目标框架：react, vue, svelte, html+css+js'),
    components: z.array(z.string()).describe('组件名列表（PascalCase）'),
    hasRouter: z.boolean().default(false).describe('是否需要路由'),
    hasStateManagement: z.boolean().default(false).describe('是否需要全局状态管理'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    features: z.array(z.string()).optional().default([]).describe('额外功能需求：animation, form-validation, http-client 等'),
  }),
  execute: async ({ framework, components, hasRouter, hasStateManagement, styleMethod, features }) => {
    const fwKey = framework.toLowerCase().includes('html') ? 'html+css+js' : framework.toLowerCase();
    const structure = FRAMEWORK_STRUCTURES[fwKey] ?? FRAMEWORK_STRUCTURES.react;

    const directories = [...structure.directories];
    const componentEntries: Array<{ component: string; directory: string; files: string[] }> = [];

    // 组件目录规划
    const componentBaseDir = fwKey === 'html+css+js'
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

    // 功能目录
    const allFeatures = [...(features ?? [])];
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
      directories: [...new Set(directories)],
      entryFiles: structure.entryFiles,
      componentEntries,
      features: allFeatures,
      instruction: `已为 ${fwKey} 框架规划项目结构：${directories.length} 个目录，${components.length} 个组件，${allFeatures.length} 个特性模块。`,
    };
  },
});

export const generateConfigFile = tool({
  description: '生成项目配置文件内容（package.json, tsconfig.json, vite.config.ts, .gitignore 等）',
  inputSchema: z.object({
    configType: z.enum(['package.json', 'tsconfig.json', 'vite.config', 'gitignore']).describe('配置文件类型'),
    framework: z.string().describe('目标框架'),
    projectName: z.string().default('my-app').describe('项目名'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    dependencies: z.record(z.string()).optional().describe('额外生产依赖'),
    devDependencies: z.record(z.string()).optional().describe('额外开发依赖'),
    scripts: z.record(z.string()).optional().describe('自定义 npm scripts'),
  }),
  execute: async ({ configType, framework, projectName, styleMethod, dependencies, devDependencies, scripts }) => {
    const fwKey = framework.toLowerCase().includes('html') ? 'html+css+js' : framework.toLowerCase();

    switch (configType) {
      case 'package.json': {
        const fwDeps = FRAMEWORK_DEPENDENCIES[fwKey] ?? { dependencies: {}, devDependencies: {} };
        const styleDeps = STYLE_DEPENDENCIES[styleMethod] ?? { dependencies: {}, devDependencies: {} };
        return {
          fileName: 'package.json',
          content: generatePackageJson({
            projectName,
            framework: fwKey,
            dependencies: { ...fwDeps.dependencies, ...styleDeps.dependencies, ...(dependencies ?? {}) },
            devDependencies: { ...fwDeps.devDependencies, ...styleDeps.devDependencies, ...(devDependencies ?? {}) },
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

export const inferDependencies = tool({
  description: '根据框架、样式方案和功能特性推断完整的 npm 依赖清单',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    styleMethod: z.string().default('tailwind').describe('样式方案'),
    features: z.array(z.string()).optional().default([]).describe('额外功能：router, state-management, animation, form-validation, icon-library, http-client, testing'),
  }),
  execute: async ({ framework, styleMethod, features }) => {
    const fwKey = framework.toLowerCase().includes('html') ? 'html+css+js' : framework.toLowerCase();
    const fwDeps = FRAMEWORK_DEPENDENCIES[fwKey] ?? { dependencies: {}, devDependencies: {} };
    const styleDeps = STYLE_DEPENDENCIES[styleMethod] ?? { dependencies: {}, devDependencies: {} };

    const allDeps: Record<string, string> = { ...fwDeps.dependencies, ...styleDeps.dependencies };
    const allDevDeps: Record<string, string> = { ...fwDeps.devDependencies, ...styleDeps.devDependencies };

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

export const generateScaffoldCommands = tool({
  description: '生成项目初始化脚手架命令（npm create, pnpm create 等）',
  inputSchema: z.object({
    framework: z.string().describe('目标框架'),
    packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('pnpm').describe('包管理器'),
    projectName: z.string().default('my-app').describe('项目名'),
    typescript: z.boolean().default(true).describe('是否使用 TypeScript'),
  }),
  execute: async ({ framework, packageManager, projectName, typescript }) => {
    const fwKey = framework.toLowerCase().includes('html') ? 'html+css+js' : framework.toLowerCase();
    const commands: Array<{ command: string; description: string; optional: boolean }> = [];

    // 包管理器安装指令前缀
    const installCmd = {
      npm: 'npm install',
      pnpm: 'pnpm install',
      yarn: 'yarn',
      bun: 'bun install',
    }[packageManager];

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
