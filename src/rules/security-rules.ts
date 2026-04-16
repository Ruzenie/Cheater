/**
 * security-rules.ts — 前端安全规则引擎
 *
 * 零 LLM 成本的静态扫描，覆盖常见前端安全漏洞。
 * 比让模型检查安全问题更准确、更便宜、更快。
 */

export type Severity = 'critical' | 'warning' | 'info';

export interface SecurityIssue {
  severity: Severity;
  rule: string;
  message: string;
  count: number;
  matches: string[];
}

interface SecurityRule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  message: string;
}

const RULES: SecurityRule[] = [
  // ── Critical ───────────────────────────────
  {
    id: 'XSS-001',
    pattern: /dangerouslySetInnerHTML/g,
    severity: 'critical',
    message: 'XSS 风险：使用了 dangerouslySetInnerHTML，请确认输入已经过消毒处理',
  },
  {
    id: 'XSS-002',
    pattern: /\beval\s*\(/g,
    severity: 'critical',
    message: '代码注入风险：使用了 eval()，应使用更安全的替代方案',
  },
  {
    id: 'XSS-003',
    pattern: /document\.write\s*\(/g,
    severity: 'critical',
    message: 'XSS 风险：使用了 document.write，应使用 DOM API 替代',
  },
  {
    id: 'XSS-004',
    pattern: /\.innerHTML\s*=/g,
    severity: 'critical',
    message: 'XSS 风险：直接赋值 innerHTML，应使用 textContent 或框架的绑定机制',
  },
  {
    id: 'INJECT-001',
    pattern: /new\s+Function\s*\(/g,
    severity: 'critical',
    message: '代码注入风险：使用了 new Function()，等同于 eval',
  },

  // ── Warning ────────────────────────────────
  {
    id: 'STORAGE-001',
    pattern: /localStorage\.setItem\s*\(\s*['"`].*(?:token|password|secret|key|auth)/gi,
    severity: 'warning',
    message: '敏感数据风险：疑似将凭据存入 localStorage，建议使用 httpOnly cookie',
  },
  {
    id: 'STORAGE-002',
    pattern: /sessionStorage\.setItem\s*\(\s*['"`].*(?:token|password|secret)/gi,
    severity: 'warning',
    message: '敏感数据风险：疑似将凭据存入 sessionStorage',
  },
  {
    id: 'CORS-001',
    pattern: /Access-Control-Allow-Origin.*\*/g,
    severity: 'warning',
    message: 'CORS 配置过宽：允许所有来源访问，应限定为可信域名',
  },
  {
    id: 'HTTP-001',
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/g,
    severity: 'warning',
    message: '不安全的 HTTP 链接：生产环境应使用 HTTPS',
  },
  {
    id: 'DEP-001',
    pattern: /target\s*=\s*['"`]_blank['"`](?![^>]*rel\s*=)/g,
    severity: 'warning',
    message: '安全风险：target="_blank" 缺少 rel="noopener noreferrer"',
  },

  // ── Info ────────────────────────────────────
  {
    id: 'DEBUG-001',
    pattern: /console\.(log|debug|info|warn)\s*\(/g,
    severity: 'info',
    message: '生产代码中存在 console 输出，上线前应清除',
  },
  {
    id: 'TODO-001',
    pattern: /\/\/\s*TODO\b/gi,
    severity: 'info',
    message: '存在未完成的 TODO 注释',
  },
  {
    id: 'DEBUG-002',
    pattern: /debugger\b/g,
    severity: 'info',
    message: '存在 debugger 断点语句',
  },
];

/**
 * 扫描代码并返回安全问题列表
 */
export function scanSecurity(code: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  for (const rule of RULES) {
    // 重置 regex 状态
    rule.pattern.lastIndex = 0;
    const matches = code.match(rule.pattern);
    if (matches && matches.length > 0) {
      issues.push({
        severity: rule.severity,
        rule: rule.id,
        message: rule.message,
        count: matches.length,
        matches: matches.slice(0, 5), // 最多展示5个匹配
      });
    }
  }

  // 按严重等级排序
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return issues;
}

/**
 * 判断是否有阻断性问题
 */
export function hasBlockingIssues(issues: SecurityIssue[]): boolean {
  return issues.some((i) => i.severity === 'critical');
}
