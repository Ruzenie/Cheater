/**
 * demo/04-full-pipeline.ts — 完整 Pipeline 演示（v5）
 *
 * 需求精炼 → 设计分析 → 项目规划 → 代码生成 → 代码审计 → 代码组装
 * 组装结果写入 output/full-pipeline/ 目录
 *
 * 用法：pnpm demo:full
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from '../src/config/index.js';
import { runOrchestrator } from '../src/agents/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output/full-pipeline');

async function main() {
  const providers = createProviders();

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

  if (!result.code || result.code.components.length === 0) {
    console.log('\nℹ️ 未生成可写入的代码文件。');
    return;
  }

  // 输出总结
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
