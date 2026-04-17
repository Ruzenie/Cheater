/**
 * @file security-rules.ts — 前端安全规则引擎
 *
 * @description
 * 本文件实现了零 LLM 成本的前端安全静态扫描器。
 * 通过预定义的正则表达式规则，检测生成代码中的常见安全漏洞。
 *
 * 在 Cheater 系统中的角色：
 *   在代码审计阶段（code-auditor），此扫描器作为第一道防线，
 *   比让 LLM 检查安全问题更准确、更便宜、更快。
 *   扫描结果会被注入审计报告，供 LLM 参考和决策。
 *
 * 覆盖的安全检查项：
 *   Critical 级别（阻断性）：
 *     - XSS-001: dangerouslySetInnerHTML
 *     - XSS-002: eval() 调用
 *     - XSS-003: document.write()
 *     - XSS-004: innerHTML 直接赋值
 *     - INJECT-001: new Function() 构造
 *
 *   Warning 级别（警告性）：
 *     - STORAGE-001/002: 敏感数据存入 localStorage/sessionStorage
 *     - CORS-001: Access-Control-Allow-Origin: * 过宽配置
 *     - HTTP-001: 非 localhost 的 HTTP 链接
 *     - DEP-001: target="_blank" 缺少 rel="noopener noreferrer"
 *
 *   Info 级别（提示性）：
 *     - DEBUG-001: 生产代码中的 console 输出
 *     - TODO-001: 未完成的 TODO 注释
 *     - DEBUG-002: debugger 断点语句
 */

/** 安全问题的严重等级：critical=阻断性, warning=警告性, info=提示性 */
export type Severity = 'critical' | 'warning' | 'info';

/**
 * 安全扫描结果中的单个问题
 */
export interface SecurityIssue {
  /** 严重等级 */
  severity: Severity;
  /** 规则 ID（如 'XSS-001'） */
  rule: string;
  /** 人类可读的问题描述（中文） */
  message: string;
  /** 匹配到的次数 */
  count: number;
  /** 匹配到的代码片段（最多 5 个） */
  matches: string[];
}

/**
 * 内部安全规则定义
 */
interface SecurityRule {
  /** 规则唯一标识符 */
  id: string;
  /** 匹配模式（正则表达式，必须带 /g 标志） */
  pattern: RegExp;
  /** 严重等级 */
  severity: Severity;
  /** 问题描述 */
  message: string;
}

/** 预定义的安全规则列表，按严重等级分组 */
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

  // ── Warning 级别 ────────────────────────────────
  // 以下规则检测潜在的安全风险，不一定是漏洞，但需要开发者注意
  {
    id: 'STORAGE-001',
    // 正则说明：匹配 localStorage.setItem('...(token|password|secret|key|auth)...')
    // /gi 标志：全局匹配 + 大小写不敏感
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
    // 正则说明：匹配 http:// 开头的 URL，但排除 localhost 和 127.0.0.1
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/g,
    severity: 'warning',
    message: '不安全的 HTTP 链接：生产环境应使用 HTTPS',
  },
  {
    id: 'DEP-001',
    // 正则说明：匹配 target="_blank" 后面没有紧跟 rel= 的情况
    // 使用否定前瞻 (?!...) 确保后续标签内容中不包含 rel=
    pattern: /target\s*=\s*['"`]_blank['"`](?![^>]*rel\s*=)/g,
    severity: 'warning',
    message: '安全风险：target="_blank" 缺少 rel="noopener noreferrer"',
  },

  // ── Info 级别 ────────────────────────────────────
  // 以下规则检测代码质量问题，不影响安全但需要上线前清理
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
 *
 * @description
 * 遍历所有预定义的安全规则，对输入代码进行正则匹配。
 * 每条匹配到的规则会生成一个 SecurityIssue，包含匹配次数和代码片段。
 * 结果按严重等级排序（critical → warning → info）。
 *
 * @param code - 要扫描的源代码字符串
 * @returns 安全问题列表，按严重等级排序
 */
export function scanSecurity(code: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  for (const rule of RULES) {
    // 重置 regex 状态（带 /g 标志的正则表达式会记住 lastIndex）
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

  // 按严重等级排序：critical(0) → warning(1) → info(2)
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return issues;
}

/**
 * 判断扫描结果中是否存在阻断性问题（critical 级别）
 *
 * @description
 * 如果存在 critical 级别的安全问题，pipeline 应中止或要求 LLM 修复。
 * 用于代码审计阶段的门禁判断。
 *
 * @param issues - scanSecurity 返回的安全问题列表
 * @returns 如果存在 critical 级别问题则返回 true
 */
export function hasBlockingIssues(issues: SecurityIssue[]): boolean {
  return issues.some((i) => i.severity === 'critical');
}
