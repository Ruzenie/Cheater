/**
 * @file demo/00-prompt-refine.ts — 需求精炼 Agent 独立演示
 *
 * 本脚本演示 Cheater 系统中 Prompt Refiner Agent 的独立使用。
 * Prompt Refiner 负责将用户的模糊需求描述精炼为结构化的、
 * 可被后续 Agent 准确理解的需求规格。
 *
 * 演示内容：
 *   - 从简单到复杂的三个测试需求
 *   - 精炼前后的对比输出
 *   - 识别出的实体（组件、样式、功能等）
 *   - 提取的技术约束条件
 *   - 推荐的技术栈建议
 *   - 成本报告（显示 LLM token 消耗）
 *
 * 用法：pnpm demo:refine
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runPromptRefiner } from '../src/agents/prompt-refiner.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

// 三个由简到繁的测试需求，用于验证精炼器的处理能力
const testRequirements = [
  '帮我搞个登录页面，要好看点，带验证码那种',
  '做一个带暗色模式切换的响应式导航栏组件，包含 logo、导航链接列表、搜索框和用户头像下拉菜单，小屏幕折叠为汉堡菜单',
  '我需要一个数据看板，有折线图柱状图那种，可以筛选日期范围，数据从后端 API 拿',
];

/**
 * 主函数：依次对每个测试需求执行精炼，并输出对比结果。
 */
async function main() {
  // 创建模型提供者实例（读取环境变量中的 API Key）
  const providers = createProviders();

  for (const req of testRequirements) {
    console.log('\n' + '═'.repeat(60));
    // 调用 Prompt Refiner Agent 执行需求精炼
    const result = await runPromptRefiner(req, providers);

    // 输出精炼前后的对比
    console.log('\n--- 对比 ---');
    console.log(`原始：${result.original}`);
    console.log(`精炼：${result.refined}`);

    if (result.entities.length > 0) {
      console.log(`实体：`);
      for (const e of result.entities) {
        console.log(`  [${e.type}] ${e.value}`);
      }
    }

    if (result.constraints.length > 0) {
      console.log(`约束：${result.constraints.join('、')}`);
    }

    if (result.suggestedStack) {
      console.log(`建议：${JSON.stringify(result.suggestedStack)}`);
    }
  }

  // 输出 LLM 调用的成本报告
  console.log('\n' + '═'.repeat(60));
  printCostReport();
}

// 启动并捕获顶层错误
main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
