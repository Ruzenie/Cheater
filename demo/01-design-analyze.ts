/**
 * @file demo/01-design-analyze.ts — 设计分析 Agent 独立演示
 *
 * 本脚本演示 Cheater 系统中 Design Analyzer Agent 的独立使用。
 * Design Analyzer 负责将需求描述拆解为组件树结构，
 * 并规划响应式策略和状态管理方案。
 *
 * 演示内容：
 *   - 将复杂需求拆解为组件树（名称、描述、Props）
 *   - 响应式布局策略推荐（断点、布局方式）
 *   - 状态管理方案建议
 *   - 成本报告
 *
 * 用法：npm run demo:design
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runDesignAnalyzer } from '../src/agents/design-analyzer.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

/**
 * 主函数：运行设计分析并输出结果。
 */
async function main() {
  // 创建模型提供者实例
  const providers = createProviders();

  // 使用一个包含多个子组件的复杂需求进行测试
  const result = await runDesignAnalyzer(
    '做一个带暗色模式切换的响应式导航栏组件，包含 logo、导航链接列表、搜索框和用户头像下拉菜单，小屏幕折叠为汉堡菜单',
    providers,
    { framework: 'react', styleSystem: 'tailwind' },
  );

  // 输出设计分析结果
  console.log('\n═══ 设计分析结果 ═══\n');
  // 打印组件树：每个组件的名称、描述和 Props
  console.log('组件树：');
  for (const comp of result.componentTree) {
    console.log(`  📦 ${comp.name}: ${comp.description}`);
    if (comp.props.length > 0) {
      console.log(`     Props: ${comp.props.map((p) => `${p.name}: ${p.type}`).join(', ')}`);
    }
  }

  // 打印响应式策略推荐
  console.log('\n响应式策略：');
  console.log(`  方案: ${result.responsiveStrategy.approach}`);
  console.log(`  断点: ${JSON.stringify(result.responsiveStrategy.breakpoints)}`);

  // 打印状态设计建议
  console.log('\n状态设计：');
  console.log(`  推荐: ${result.stateDesign.recommendation}`);

  printCostReport();
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
