/**
 * demo/00-prompt-refine.ts — 单独运行需求精炼 Agent
 *
 * 用法：pnpm demo:refine
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runPromptRefiner } from '../src/agents/prompt-refiner.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

const testRequirements = [
  '帮我搞个登录页面，要好看点，带验证码那种',
  '做一个带暗色模式切换的响应式导航栏组件，包含 logo、导航链接列表、搜索框和用户头像下拉菜单，小屏幕折叠为汉堡菜单',
  '我需要一个数据看板，有折线图柱状图那种，可以筛选日期范围，数据从后端 API 拿',
];

async function main() {
  const providers = createProviders();

  for (const req of testRequirements) {
    console.log('\n' + '═'.repeat(60));
    const result = await runPromptRefiner(req, providers);

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

  console.log('\n' + '═'.repeat(60));
  printCostReport();
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
