/**
 * @file demo/03-code-audit.ts — 代码审计 Agent 独立演示
 *
 * 本脚本演示 Cheater 系统中 Code Auditor Agent 的独立使用。
 * Code Auditor 对代码执行静态扫描（安全 + 无障碍 + 性能）和 LLM 深度分析，
 * 生成综合审计报告和改进建议。
 *
 * 演示内容：
 *   - 使用一段故意包含多种问题的示例代码进行审计
 *   - 安全扫描结果（XSS、敏感数据暴露等）
 *   - 无障碍检查结果（img alt、button 文本等）
 *   - 性能分析结果（整包导入、index key 等）
 *   - LLM 深度分析（风险评估和改进建议）
 *   - 综合评分和通过状态
 *
 * 用法：npm run demo:audit
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runCodeAuditor } from '../src/agents/code-auditor.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

// 一段故意包含多种安全、无障碍和性能问题的示例代码，用于演示审计能力
// 包含的问题：dangerouslySetInnerHTML / localStorage 存敏感数据 / img 缺 alt /
//            lodash 整包导入 / fetch 无错误处理 / index 作 key / button 无文本 等
const SAMPLE_CODE = `
import React, { useState } from 'react';
import _ from 'lodash';

export default function UserProfile({ user }) {
  const [bio, setBio] = useState('');

  const handleSave = async () => {
    const response = await fetch('/api/user', {
      method: 'POST',
      body: JSON.stringify({ bio }),
    });
    const data = await response.json();
    localStorage.setItem('auth_token', data.token);
    console.log('saved:', data);
  };

  return (
    <div>
      <img src={user.avatar} />
      <div dangerouslySetInnerHTML={{ __html: user.bio }} />
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        style={{ outline: 'none' }}
      />
      <button onClick={handleSave}></button>
      {user.posts.map((post, index) => (
        <div key={index} onClick={() => window.open(post.url)}>
          <a href={post.url} target="_blank">{post.title}</a>
        </div>
      ))}
    </div>
  );
}
`;

/**
 * 主函数：对示例代码执行审计并输出报告。
 */
async function main() {
  const providers = createProviders();

  // 运行审计 Agent，启用深度分析，质量阈值设为 7 分
  const result = await runCodeAuditor(SAMPLE_CODE, providers, {
    framework: 'react',
    skipDeepAnalysis: false,
    qualityThreshold: 7,
  });

  console.log('\n═══ 审计报告 ═══\n');
  console.log(`评分：${result.overallScore}/10`);
  console.log(`结果：${result.passed ? '✅ 通过' : '❌ 不通过'}`);

  console.log('\n📋 安全扫描：');
  for (const issue of result.staticScan.security.issues) {
    console.log(`  [${issue.severity}] ${issue.rule}: ${issue.message}`);
  }

  console.log('\n♿ 无障碍检查：');
  for (const issue of result.staticScan.a11y.issues) {
    console.log(`  [${issue.severity}] ${issue.rule}: ${issue.message}`);
  }

  console.log('\n⚡ 性能分析：');
  for (const issue of result.staticScan.performance.issues) {
    console.log(`  [${issue.severity}] ${issue.rule}: ${issue.message}`);
  }

  console.log('\n🧠 深度分析：');
  console.log(`  风险评估：${result.deepAnalysis.riskAssessment}`);
  for (const suggestion of result.deepAnalysis.improvementSuggestions) {
    console.log(`  💡 ${suggestion}`);
  }

  console.log(`\n📝 总结：${result.summary}`);

  printCostReport();
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
