/**
 * @file tools/web/index.ts — 联网查询工具集
 *
 * 本文件定义了允许 AI Agent 联网获取外部资料的工具集。
 * 在 Cheater 系统中，这些工具可被任意 Agent 调用，用于：
 *   - 查询最新的 npm 包信息和版本
 *   - 搜索框架文档和最佳实践
 *   - 抓取技术文档的指定章节
 *
 * 提供的工具：
 *   1. webSearch       — 通过 DuckDuckGo 搜索引擎查询信息
 *   2. fetchUrl        — 抓取指定 URL 内容（支持 HTML→文本转换）
 *   3. npmPackageInfo  — 查询 npm 包详细信息（版本、依赖、许可证等）
 *   4. fetchDocSnippet — 抓取技术文档页面并提取指定主题的内容片段
 *
 * 内部辅助函数：
 *   - safeFetch()  — 带超时和错误兜底的 fetch 封装
 *   - htmlToText() — 粗略的 HTML→纯文本转换
 *
 * 设计原则：
 *   - 所有工具均为只读操作，不修改任何本地文件
 *   - 使用 Node.js 内置 fetch（Node 18+），无需额外依赖
 *   - 内容过长时自动截断，避免 token 浪费
 *   - 不需要任何 API Key（DuckDuckGo HTML 搜索 + npm registry 公开 API）
 */

import { tool } from 'ai';
import { z } from 'zod';

// ── 内部辅助常量 ──────────────────────────────────
/** 默认请求超时时间（毫秒），超时后自动中止请求 */
const DEFAULT_TIMEOUT = 10_000;
/** 抓取内容的最大长度（字符数），超过则截断并在末尾提示 */
const MAX_CONTENT_LENGTH = 15_000;

/** 默认请求头，模拟常见浏览器 User-Agent 以提高对目标网站的兼容性 */
const DEFAULT_HEADERS = {
  'User-Agent': 'FrontendAgent/1.0 (Node.js)',
  Accept: 'text/html,application/json,text/plain;q=0.9',
};

/**
 * 带超时和错误兜底的 fetch 封装。
 *
 * 使用 AbortController 实现请求超时控制。
 * 所有异常均被捕获并返回结构化的错误信息，不会向外抛出。
 * 内容过长时自动截断到 MAX_CONTENT_LENGTH。
 *
 * @param url - 请求的目标 URL
 * @param options - 可选的超时时间和自定义请求头
 * @returns 统一格式的响应结果（ok / status / text / contentType）
 */
async function safeFetch(
  url: string,
  options: {
    timeout?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  const { timeout = DEFAULT_TIMEOUT, headers = {} } = options;
  try {
    // 使用 AbortController 实现请求超时
    /**
     * controller = {
     *    signal: AbortSignal { aborted: false, onabort: null, reason: undefined, throwIfAborted: [Function] },
     *    abort: [Function]
     * }
     */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { ...DEFAULT_HEADERS, ...headers },
      });

      clearTimeout(timer);

      const contentType = response.headers.get('content-type') ?? '';
      let text = await response.text();

      // 截断过长内容
      if (text.length > MAX_CONTENT_LENGTH) {
        text = text.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [内容已截断]';
      }

      return {
        ok: response.ok,
        status: response.status,
        text,
        contentType,
      };
    } catch (fetchError) {
      clearTimeout(timer); // 确保异常路径也清理定时器
      throw fetchError; // 重新抛出，由外层 catch 处理
    }
  } catch (error: unknown) {
    // 统一处理所有错误类型：超时（AbortError）和其他网络错误
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `请求超时 (${timeout}ms)`
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      ok: false,
      status: 0,
      text: `请求失败: ${message}`,
      contentType: '',
    };
  }
}

/**
 * 粗略地从 HTML 中提取纯文本内容。
 *
 * 处理步骤：
 *   1. 移除 script 和 style 块
 *   2. 移除 HTML 注释
 *   3. 将块级标签（p / div / li / h1-h6 等）替换为换行符
 *   4. 移除所有剩余 HTML 标签
 *   5. 解码常见 HTML 实体（&amp; &lt; &gt; 等）
 *   6. 压缩多余空行
 *
 * @param html - 原始 HTML 字符串
 * @returns 提取后的纯文本
 */
function htmlToText(html: string): string {
  return (
    html
      // 移除 script 和 style 块
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      // 移除 HTML 注释
      .replace(/<!--[\s\S]*?-->/g, '')
      // 将 br/p/div/li/h* 等块级标签替换为换行
      .replace(/<\/?(?:br|p|div|li|h[1-6]|tr|section|article|header|footer|nav|main)[^>]*>/gi, '\n')
      // 移除剩余标签
      .replace(/<[^>]+>/g, '')
      // 解码常见 HTML 实体
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // 压缩空行
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

// ── AI SDK 工具定义 ──────────────────────────────────

/**
 * webSearch — 通过搜索引擎查询信息。
 *
 * 使用 DuckDuckGo HTML 搜索（不需要 API Key），从 HTML 结果中解析标题、URL 和摘要。
 * 支持中英文搜索。如果 HTML 解析失败，回退到纯文本提取。
 *
 * @param query - 搜索关键词
 * @param maxResults - 最大结果数（1-10，默认 5）
 * @param language - 搜索语言偏好（'zh' 或 'en'，默认 'en'）
 * @returns 搜索结果列表（标题 + URL + 摘要）
 */
export const webSearch = tool({
  description:
    '通过搜索引擎查询信息，返回搜索结果摘要。可查询 npm 包、框架文档、最佳实践、API 参考等',
  inputSchema: z.object({
    query: z.string().describe('搜索关键词，例如 "react modal component best practice 2024"'),
    maxResults: z.number().min(1).max(10).default(5).describe('返回的最大结果数'),
    language: z.enum(['zh', 'en']).default('en').describe('搜索语言偏好'),
  }),
  execute: async ({ query, maxResults, language }) => {
    // 使用 DuckDuckGo HTML 搜索（不需要 API key）
    const encodedQuery = encodeURIComponent(query);
    const languageParam = language === 'zh' ? '&kl=cn-zh' : '';
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}${languageParam}`;

    const result = await safeFetch(url, { timeout: 15_000 });

    if (!result.ok) {
      return {
        success: false,
        query,
        error: result.text,
        results: [],
      };
    }

    // 从 HTML 中提取搜索结果 —— 解析 DuckDuckGo 的 HTML 结构
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // 匹配 DuckDuckGo 搜索结果条目：result__a（标题链接）+ result__snippet（摘要）
    const resultBlocks =
      result.text.match(
        /<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/gi,
      ) ?? [];

    for (const block of resultBlocks.slice(0, maxResults)) {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const urlMatch = block.match(/href="([^"]+)"/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

      if (titleMatch) {
        const rawUrl = urlMatch?.[1] ?? '';
        // DuckDuckGo 的链接是跳转链接（/l/?uddg=真实URL），需要提取真实 URL
        const realUrlMatch = rawUrl.match(/uddg=(.*?)(?:&|$)/);
        const finalUrl = realUrlMatch ? decodeURIComponent(realUrlMatch[1]) : rawUrl;

        results.push({
          title: htmlToText(titleMatch[1]).trim(),
          url: finalUrl,
          snippet: htmlToText(snippetMatch?.[1] ?? '').trim(),
        });
      }
    }

    // 如果正则解析失败（页面结构变化等），回退到纯文本提取
    if (results.length === 0) {
      const plainText = htmlToText(result.text);
      return {
        success: true,
        query,
        results: [],
        rawTextPreview: plainText.slice(0, 2000),
        note: '无法解析搜索结果结构，返回原始文本摘要',
      };
    }

    return {
      success: true,
      query,
      totalResults: results.length,
      results,
    };
  },
});

/**
 * fetchUrl — 抓取指定 URL 的内容。
 *
 * 支持 HTML 页面、JSON API、纯文本等多种内容类型。
 * HTML 内容可自动转为纯文本（去除标签），JSON 内容自动格式化。
 * 超过最大长度时自动截断。
 *
 * @param url - 要抓取的 URL（必须是合法 URL）
 * @param extractText - 是否将 HTML 转为纯文本（默认 true）
 * @param maxLength - 最大返回内容长度（默认 10000 字符）
 * @param headers - 自定义请求头（可选）
 * @returns 抓取状态、内容类型和内容文本
 */
export const fetchUrl = tool({
  description: '抓取指定 URL 的内容，支持 HTML 页面、JSON API、纯文本。自动将 HTML 转为纯文本',
  inputSchema: z.object({
    url: z.string().url().describe('要抓取的 URL'),
    extractText: z.boolean().default(true).describe('是否将 HTML 转为纯文本（默认 true）'),
    maxLength: z.number().min(100).max(50000).default(10000).describe('最大返回内容长度（字符数）'),
    headers: z.record(z.string()).optional().describe('自定义请求头'),
  }),
  execute: async ({ url, extractText, maxLength, headers }) => {
    const result = await safeFetch(url, { headers });

    if (!result.ok) {
      return {
        success: false,
        url,
        status: result.status,
        error: result.text,
      };
    }

    let content = result.text;
    const isHtml = result.contentType.includes('html');
    const isJson = result.contentType.includes('json');

    if (isHtml && extractText) {
      content = htmlToText(content);
    }

    if (isJson) {
      try {
        const parsed = JSON.parse(content);
        content = JSON.stringify(parsed, null, 2);
      } catch {
        // 保持原始文本
      }
    }

    // 截断
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n... [内容已截断]';
    }

    return {
      success: true,
      url,
      status: result.status,
      contentType: isHtml ? 'html→text' : isJson ? 'json' : 'text',
      contentLength: content.length,
      content,
    };
  },
});

/**
 * npmPackageInfo — 查询 npm 包的详细信息。
 *
 * 直接请求 npm registry 公开 API（https://registry.npmjs.org/），
 * 提取最新版本、描述、许可证、主页、关键词、依赖列表等信息。
 * 不需要任何 API Key。
 *
 * @param packageName - npm 包名（如 'react-router-dom' 或 '@tanstack/react-query'）
 * @returns 包的详细信息或错误信息
 */
export const npmPackageInfo = tool({
  description: '查询 npm 包的详细信息，包括最新版本、描述、依赖、关键词等',
  inputSchema: z.object({
    packageName: z
      .string()
      .describe('npm 包名，例如 "react-router-dom" 或 "@tanstack/react-query"'),
  }),
  execute: async ({ packageName }) => {
    const encodedName = encodeURIComponent(packageName);
    const result = await safeFetch(`https://registry.npmjs.org/${encodedName}`, {
      headers: { Accept: 'application/json' },
    });

    if (!result.ok) {
      return {
        success: false,
        packageName,
        error: result.status === 404 ? '包不存在' : result.text,
      };
    }

    try {
      const data = JSON.parse(result.text);
      const latestVersion = data['dist-tags']?.latest ?? 'unknown';
      const latestInfo = data.versions?.[latestVersion] ?? {};

      return {
        success: true,
        packageName: data.name,
        description: data.description ?? '',
        latestVersion,
        license: latestInfo.license ?? data.license ?? 'unknown',
        homepage: data.homepage ?? '',
        repository:
          typeof data.repository === 'object' ? data.repository.url : (data.repository ?? ''),
        keywords: (data.keywords ?? []).slice(0, 15),
        dependencies: Object.keys(latestInfo.dependencies ?? {}),
        peerDependencies: Object.keys(latestInfo.peerDependencies ?? {}),
        maintainers: (data.maintainers ?? [])
          .slice(0, 5)
          .map((m: Record<string, string>) => m.name ?? m.email ?? ''),
        lastModified: data.time?.[latestVersion] ?? '',
        weeklyDownloads: '使用 https://api.npmjs.org/downloads/point/last-week/ 查询',
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        packageName,
        error: `JSON 解析失败: ${message}`,
      };
    }
  },
});

/**
 * fetchDocSnippet — 抓取技术文档页面并提取指定主题的内容片段。
 *
 * 先将 HTML 转为纯文本，然后搜索包含关键词的行，
 * 提取每个匹配位置前后 N 行作为上下文片段。
 * 最多返回 3 个不重叠的匹配片段。
 *
 * @param url - 文档页面 URL
 * @param topic - 要提取的主题关键词
 * @param contextLines - 关键词前后各取多少行作为上下文（默认 30）
 * @returns 匹配的内容片段列表，或未找到时的页面预览
 */
export const fetchDocSnippet = tool({
  description: '抓取技术文档页面并提取指定主题的内容片段。适合快速查阅 API 参考、用法示例等',
  inputSchema: z.object({
    url: z.string().url().describe('文档页面 URL'),
    topic: z.string().describe('要提取的主题关键词，例如 "useEffect" 或 "路由配置"'),
    contextLines: z.number().min(5).max(100).default(30).describe('关键词前后各取多少行作为上下文'),
  }),
  execute: async ({ url, topic, contextLines }) => {
    const result = await safeFetch(url);

    if (!result.ok) {
      return {
        success: false,
        url,
        topic,
        error: result.text,
      };
    }

    const plainText = htmlToText(result.text);
    const lines = plainText.split('\n');

    // 查找包含关键词的所有行号
    const topicLower = topic.toLowerCase();
    const matchingIndices: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(topicLower)) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 0) {
      return {
        success: true,
        url,
        topic,
        found: false,
        totalLines: lines.length,
        snippet: '',
        note: `未在页面中找到 "${topic}" 相关内容`,
        pagePreview: plainText.slice(0, 1000),
      };
    }

    // 提取每个匹配位置前后 contextLines 行作为上下文
    const snippets: string[] = [];
    const seen = new Set<number>();  // 记录已处理的匹配位置，避免重叠区间

    for (const idx of matchingIndices.slice(0, 3)) {  // 最多取 3 个匹配片段
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length, idx + contextLines + 1);

      // 检查是否与已处理的匹配位置重叠（距离小于 contextLines）
      if ([...seen].some((s) => Math.abs(s - idx) < contextLines)) {
        continue;
      }
      seen.add(idx);

      const contextBlock = lines.slice(start, end).join('\n');
      snippets.push(contextBlock);
    }

    return {
      success: true,
      url,
      topic,
      found: true,
      matchCount: matchingIndices.length,
      snippets,
      totalLines: lines.length,
    };
  },
});
