/**
 * demo/03-code-audit.ts — 单独运行代码审计 Agent
 *
 * 用法：npm run demo:audit
 */

import 'dotenv/config';
import { createProviders } from '../src/config/index.js';
import { runCodeAuditor } from '../src/agents/code-auditor.js';
import { printCostReport } from '../src/middleware/cost-tracker.js';

// 一段「有问题」的示例代码，用于演示审计能力
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

async function main() {
  const providers = createProviders();

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
