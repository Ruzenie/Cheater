/**
 * @file demo/06-assemble.ts — 代码组装师独立演示
 *
 * 本脚本演示 Cheater 系统中 Code Assembler Agent 的独立使用。
 * 演示完整的四步 Pipeline：设计分析 → 项目规划 → 代码生成 → 代码组装。
 * 与 04-full-pipeline.ts 不同，本脚本显式调用各个 Agent 而非使用 Orchestrator。
 *
 * 演示内容：
 *   - 逐步执行四个 Agent
 *   - 将生成的项目文件写入 output/assembled-project/ 目录
 *   - 输出组装日志和文件列表
 *   - 生成的项目可直接用浏览器打开 index.html 查看效果
 *
 * 用法：pnpm demo:assemble
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from '../src/config/index.js';
import { runDesignAnalyzer } from '../src/agents/design-analyzer.js';
import { runProjectPlanner } from '../src/agents/project-planner.js';
import { runCodeProducer } from '../src/agents/code-producer.js';
import { runCodeAssembler } from '../src/agents/code-assembler.js';

// 计算输出目录的绝对路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output/assembled-project');

/**
 * 主函数：按顺序运行四步 Pipeline 并将结果写入磁盘。
 */
async function main() {
  const providers = createProviders();
  // 使用原生 HTML+CSS+JS 实现一个响应式登录界面
  const requirement = '使用html，css，js实现一个响应式的登录界面，支持亮暗色切换';
  const framework = 'html+css+js';
  const styleMethod = 'css';

  // Step 1: 设计分析 —— 将需求拆解为组件树
  console.log('\n═══ Step 1: 设计分析 ═══');
  const design = await runDesignAnalyzer(requirement, providers, {
    framework,
    styleSystem: styleMethod,
  });

  // Step 2: 项目结构规划 —— 生成目录结构和配置文件
  console.log('\n═══ Step 2: 项目结构规划 ═══');
  const plan = await runProjectPlanner(requirement, design, providers, {
    framework,
    styleMethod,
    darkMode: true,
  });

  // Step 3: 代码生成 —— 为每个组件生成实现代码
  console.log('\n═══ Step 3: 代码生成 ═══');
  const code = await runCodeProducer(design.componentTree, providers, {
    framework,
    styleMethod,
    darkMode: true,
  });

  // Step 4: 代码组装 —— 将所有组件整合为完整项目并写入磁盘
  console.log('\n═══ Step 4: 代码组装 ═══');
  const assembly = await runCodeAssembler(plan.structure, code, providers, {
    framework,
    styleMethod,
    darkMode: true,
    writeToFS: true,
    outputDir: OUTPUT_DIR,
  });

  // 输出组装结果总结
  console.log('\n═══ 组装结果 ═══\n');
  console.log(`📦 项目名: ${assembly.projectName}`);
  console.log(`📄 文件数: ${assembly.totalFiles}`);
  console.log(`🚀 入口: ${assembly.entryPoint}`);
  console.log(`💾 输出: ${assembly.outputDir ?? '未写入'}`);

  console.log('\n📝 组装日志:');
  for (const entry of assembly.assemblyLog) {
    console.log(`  ${entry}`);
  }

  console.log('\n📄 文件列表:');
  for (const file of assembly.files) {
    console.log(`  [${file.source.padEnd(12)}] ${file.filePath}`);
  }

  if (assembly.writtenToDisk) {
    console.log(`\n✅ 项目已写入: ${assembly.outputDir}`);
    console.log(`   可以用浏览器直接打开 ${assembly.outputDir}/index.html 查看效果`);
  }
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
