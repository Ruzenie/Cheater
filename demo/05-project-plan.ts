/**
 * @file demo/05-project-plan.ts — 项目结构规划师独立演示
 *
 * 本脚本演示 Cheater 系统中 Project Planner Agent 的独立使用。
 * 演示两步流程：先运行设计分析获取组件树，再运行项目规划获取完整结构。
 *
 * 演示内容：
 *   - 设计分析：将博客首页需求拆解为组件树
 *   - 项目规划：生成完整的目录结构、文件清单、组件映射
 *   - 依赖推断：自动推断 npm 生产依赖和开发依赖
 *   - 脚手架命令：生成安装和启动命令
 *   - AI 额外建议
 *
 * 用法：pnpm demo:plan
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runDesignAnalyzer } from '../src/agents/design-analyzer.js';
import { runProjectPlanner } from '../src/agents/project-planner.js';

/**
 * 主函数：运行设计分析 + 项目规划两步流程。
 */
async function main() {
  const providers = createProviders();

  const requirement =
    '实现一个响应式的博客首页，包含导航栏、文章列表、侧边栏标签云、底部版权信息，支持暗色模式切换';

  // Step 1: 设计分析 —— 将自然语言需求拆解为组件树
  console.log('═══ Step 1: 设计分析 ═══\n');
  const design = await runDesignAnalyzer(requirement, providers, {
    framework: 'react',
    styleSystem: 'tailwind',
  });

  // Step 2: 项目结构规划 —— 基于组件树生成完整的项目结构
  console.log('═══ Step 2: 项目结构规划 ═══\n');
  const result = await runProjectPlanner(requirement, design, providers, {
    framework: 'react',
    styleMethod: 'tailwind',
    packageManager: 'pnpm',
    darkMode: true,
  });

  // 解构项目结构数据
  const { structure } = result;

  // 输出详细的规划结果
  console.log('\n═══ 规划结果详情 ═══\n');
  console.log(`📦 项目名: ${structure.projectName}`);
  console.log(`🛠️  框架: ${structure.framework}`);
  console.log(`🎨 样式: ${structure.styleMethod}`);
  console.log(`📦 包管理器: ${structure.packageManager}`);

  console.log(`\n📂 目录结构 (${structure.directories.length} 个):`);
  for (const dir of structure.directories.sort()) {
    console.log(`  📁 ${dir}/`);
  }

  console.log(`\n📄 文件清单 (${structure.files.length} 个):`);
  for (const file of structure.files) {
    const icon =
      file.role === 'config'
        ? '⚙️'
        : file.role === 'entry'
          ? '🚀'
          : file.role === 'component'
            ? '🧩'
            : file.role === 'style'
              ? '🎨'
              : '📝';
    console.log(`  ${icon} ${file.filePath} [${file.role}] — ${file.description}`);
  }

  console.log(`\n🧩 组件映射 (${structure.componentMapping.length} 个):`);
  for (const cm of structure.componentMapping) {
    console.log(
      `  ${cm.isLayout ? '🏗️' : '📦'} ${cm.componentName} → ${cm.targetDir}/ (import: ${cm.importPath})`,
    );
  }

  console.log(
    `\n📦 依赖 (${Object.keys(structure.dependencies).length} + ${Object.keys(structure.devDependencies).length} dev):`,
  );
  console.log(
    `  生产: ${
      Object.entries(structure.dependencies)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ') || '无'
    }`,
  );
  console.log(
    `  开发: ${
      Object.entries(structure.devDependencies)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ') || '无'
    }`,
  );

  console.log(`\n🚀 启动命令:`);
  console.log(`  ${structure.installCommand}`);
  console.log(`  ${structure.devCommand}`);

  if (result.aiNotes.length > 0) {
    console.log(`\n💡 AI 建议:`);
    for (const note of result.aiNotes) {
      console.log(`  • ${note}`);
    }
  }
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
