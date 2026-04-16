/**
 * demo/06-assemble.ts — 代码组装师独立 Demo
 *
 * 演示完整 Pipeline: 设计分析 → 项目规划 → 代码生成 → 代码组装
 * 组装结果写入 output/assembled-project/ 目录
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output/assembled-project');

async function main() {
  const providers = createProviders();
  const requirement = '使用html，css，js实现一个响应式的登录界面，支持亮暗色切换';
  const framework = 'html+css+js';
  const styleMethod = 'css';

  // Step 1: 设计分析
  console.log('\n═══ Step 1: 设计分析 ═══');
  const design = await runDesignAnalyzer(requirement, providers, {
    framework,
    styleSystem: styleMethod,
  });

  // Step 2: 项目结构规划
  console.log('\n═══ Step 2: 项目结构规划 ═══');
  const plan = await runProjectPlanner(requirement, design, providers, {
    framework,
    styleMethod,
    darkMode: true,
  });

  // Step 3: 代码生成
  console.log('\n═══ Step 3: 代码生成 ═══');
  const code = await runCodeProducer(design.componentTree, providers, {
    framework,
    styleMethod,
    darkMode: true,
  });

  // Step 4: 代码组装
  console.log('\n═══ Step 4: 代码组装 ═══');
  const assembly = await runCodeAssembler(plan.structure, code, providers, {
    framework,
    styleMethod,
    darkMode: true,
    writeToFS: true,
    outputDir: OUTPUT_DIR,
  });

  // 输出总结
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
