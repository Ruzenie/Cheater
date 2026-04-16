/**
 * demo/01-design-analyze.ts — 单独运行设计分析 Agent
 *
 * 用法：npm run demo:design
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runDesignAnalyzer } from '../src/agents/design-analyzer.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

async function main() {
  const providers = createProviders();

  const result = await runDesignAnalyzer(
    '做一个带暗色模式切换的响应式导航栏组件，包含 logo、导航链接列表、搜索框和用户头像下拉菜单，小屏幕折叠为汉堡菜单',
    providers,
    { framework: 'react', styleSystem: 'tailwind' },
  );

  console.log('\n═══ 设计分析结果 ═══\n');
  console.log('组件树：');
  for (const comp of result.componentTree) {
    console.log(`  📦 ${comp.name}: ${comp.description}`);
    if (comp.props.length > 0) {
      console.log(`     Props: ${comp.props.map((p) => `${p.name}: ${p.type}`).join(', ')}`);
    }
  }

  console.log('\n响应式策略：');
  console.log(`  方案: ${result.responsiveStrategy.approach}`);
  console.log(`  断点: ${JSON.stringify(result.responsiveStrategy.breakpoints)}`);

  console.log('\n状态设计：');
  console.log(`  推荐: ${result.stateDesign.recommendation}`);

  printCostReport();
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
