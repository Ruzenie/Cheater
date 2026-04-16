/**
 * demo/02-code-produce.ts — 单独运行代码制作 Agent
 *
 * 用法：npm run demo:code
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runCodeProducer } from '../src/agents/code-producer.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';
import type { ComponentSpec } from '../src/tools/design/index.js';

async function main() {
  const providers = createProviders();

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

  const result = await runCodeProducer(specs, providers, {
    framework: 'react',
    styleMethod: 'tailwind',
    darkMode: true,
  });

  console.log('\n═══ 代码生成结果 ═══\n');
  for (const comp of result.components) {
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
