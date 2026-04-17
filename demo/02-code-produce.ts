/**
 * @file demo/02-code-produce.ts — 代码生成 Agent 独立演示
 *
 * 本脚本演示 Cheater 系统中 Code Producer Agent 的独立使用。
 * Code Producer 接收 ComponentSpec（组件规格），为每个组件生成完整的实现代码。
 *
 * 演示内容：
 *   - 手动构建 ComponentSpec（SearchInput 搜索框组件）
 *   - 使用 React + Tailwind 生成组件代码
 *   - 展示生成的文件列表和内容
 *   - 自检结果（selfReview）
 *   - 使用的生成器和模型等级信息
 *   - 成本报告
 *
 * 用法：npm run demo:code
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runCodeProducer } from '../src/agents/code-producer.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';
import type { ComponentSpec } from '../src/tools/design/index.js';

/**
 * 主函数：构建组件规格并运行代码生成。
 */
async function main() {
  // 创建模型提供者实例
  const providers = createProviders();

  // 手动构建 ComponentSpec —— 一个带防抖的搜索输入框组件
  const specs: ComponentSpec[] = [
    {
      name: 'SearchInput',
      description: '带防抖的搜索输入框，支持清除按钮和加载状态',
      props: [
        {
          name: 'placeholder',
          type: 'string',
          required: false,
          defaultValue: '"搜索..."',
          description: '占位文本',
        },
        {
          name: 'onSearch',
          type: '(query: string) => void',
          required: true,
          description: '搜索回调',
        },
        {
          name: 'debounceMs',
          type: 'number',
          required: false,
          defaultValue: '300',
          description: '防抖延迟',
        },
        {
          name: 'loading',
          type: 'boolean',
          required: false,
          defaultValue: 'false',
          description: '加载状态',
        },
      ],
      children: [],
      states: [{ name: 'value', type: 'string', description: '输入框当前值' }],
      events: [
        { name: 'onSearch', payload: 'string', description: '防抖后触发搜索' },
        { name: 'onClear', payload: 'void', description: '清除输入内容' },
      ],
    },
  ];

  // 调用 Code Producer Agent，使用 React + Tailwind + 暗色模式
  const result = await runCodeProducer(specs, providers, {
    framework: 'react',
    styleMethod: 'tailwind',
    darkMode: true,
  });

  // 输出每个组件的生成结果详情
  console.log('\n═══ 代码生成结果 ═══\n');
  for (const comp of result.components) {
    // 组件摘要：名称、生成器、使用的模型等级
    console.log(
      `📦 ${comp.componentName} (生成器: ${comp.generatorId}, 模型: ${[...new Set(comp.modelTiersUsed)].join(' → ')})`,
    );
    console.log(`   入口文件: ${comp.entryFileName}`);
    console.log(`   自检: ${comp.selfReviewResult.passed ? '✅ 通过' : '❌ 有问题'}`);
    if (comp.selfReviewResult.issues.length > 0) {
      for (const issue of comp.selfReviewResult.issues) {
        console.log(`   - [${issue.severity}] ${issue.message}`);
      }
    }

    for (const artifact of comp.artifacts) {
      console.log(`\n--- ${artifact.fileName} ---`);
      console.log(artifact.content);
      console.log('--- end ---');
    }
    console.log();
  }

  printCostReport();
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
