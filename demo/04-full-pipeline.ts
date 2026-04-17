/**
 * @file demo/04-full-pipeline.ts — 完整 Pipeline 端到端演示（v5）
 *
 * 本脚本演示 Cheater 系统完整的六阶段 Pipeline：
 *   需求精炼 → 设计分析 → 项目规划 → 代码生成 → 代码审计 → 代码组装
 *
 * 通过 Orchestrator Agent 统一调度全部流程，最终将组装结果写入磁盘。
 *
 * 演示内容：
 *   - 使用一个 HTML+CSS+JS 登录界面需求作为输入
 *   - Orchestrator 自动调度所有 Agent
 *   - 将生成的项目文件写入 output/full-pipeline/ 目录
 *   - 输出项目摘要（文件数、入口文件、输出路径）
 *   - 最终判定结果和总成本
 *
 * 用法：pnpm demo:full
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from '../src/config/index.js';
import { runOrchestrator } from '../src/agents/orchestrator.js';

// 计算输出目录的绝对路径（相对于本文件位置）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output/full-pipeline');

/**
 * 主函数：运行完整 Pipeline 并输出结果。
 */
async function main() {
  const providers = createProviders();

  // 通过 Orchestrator 运行完整 Pipeline
  // 配置：HTML+CSS+JS 框架、CSS 样式、暗色模式、写入磁盘
  const result = await runOrchestrator(
    '使用html，css，js实现一个响应式的登录界面，支持亮暗色切换，并且支持pc端和移动设备上有良好的用户体验。',
    providers,
    {
      framework: 'html+css+js',
      styleMethod: 'css',
      darkMode: true,
      skipDeepAnalysis: false,
      writeToFS: true,
      outputDir: OUTPUT_DIR,
    },
  );

  // 检查是否成功生成了代码文件
  if (!result.code || result.code.components.length === 0) {
    console.log('\nℹ️ 未生成可写入的代码文件。');
    return;
  }

  // 输出 Pipeline 完成后的总结信息
  console.log('\n═══ Pipeline 完成 ═══\n');

  if (result.assembly) {
    console.log(`📦 项目: ${result.assembly.projectName}`);
    console.log(`📄 文件: ${result.assembly.totalFiles} 个`);
    console.log(`🚀 入口: ${result.assembly.entryPoint}`);

    if (result.assembly.writtenToDisk) {
      console.log(`💾 输出: ${result.assembly.outputDir}`);

      console.log('\n📄 文件列表:');
      for (const file of result.assembly.files) {
        console.log(`  [${file.source.padEnd(12)}] ${file.filePath}`);
      }
    }
  }

  console.log(`\n🏁 最终结果: ${result.finalVerdict}`);
  console.log(`💰 总成本: $${result.totalCost.toFixed(6)}`);
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
