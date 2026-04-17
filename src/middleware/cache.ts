/**
 * @file cache.ts — LLM 响应缓存中间件
 *
 * @description
 * 本文件实现了基于参数序列化的 LLM 响应缓存中间件。
 * 在开发和调试阶段，对于相同的 Prompt 参数，直接返回缓存结果，
 * 从而大幅减少 API 调用次数和成本开销。
 *
 * 在 Cheater 系统中的角色：
 *   该中间件位于 LLM 调用管线的最外层，作为请求拦截器。
 *   当 pipeline 的某个步骤（如 design-analyzer、code-producer）发起
 *   generateText 调用时，中间件会先检查缓存是否命中，命中则直接返回，
 *   否则执行真实调用并将结果写入缓存。
 *
 * 技术细节：
 *   - 遵循 AI SDK v6 LanguageModelV3Middleware 规范
 *   - wrapGenerate: 对 doGenerate（非流式）调用进行完整缓存
 *   - wrapStream: 直接透传（流式响应是实时消费的，缓存会导致流挂起）
 *   - 默认使用内存 Map 缓存，支持 TTL 过期和 LRU 淘汰策略
 *   - 可通过 createCacheMiddleware 注入外部存储（Redis、文件系统等）
 *
 * 缓存策略：
 *   - 默认 TTL: 30 分钟
 *   - 硬上限: 500 条目，超限时按 LRU 淘汰最久未访问的 100 条
 *   - 每 100 次写入触发一次过期条目清理
 *   - 生产环境默认禁用（通过 NODE_ENV 判断）
 */

import type { LanguageModelMiddleware } from 'ai';

// ── 缓存接口（可扩展为 Redis/文件/IndexedDB）──

/**
 * 缓存存储接口
 *
 * @description
 * 定义了缓存存储的最小契约，任何实现此接口的类都可以作为缓存后端。
 * 默认实现为内存 Map，外部可替换为 Redis、文件系统、IndexedDB 等。
 */
export interface CacheStore {
  /**
   * 根据 key 获取缓存值
   * @param key - 缓存键（通常是请求参数的 JSON 序列化字符串）
   * @returns 缓存值，未命中或已过期返回 null
   */
  get(key: string): Promise<unknown | null>;
  /**
   * 设置缓存值
   * @param key - 缓存键
   * @param value - 要缓存的值（LLM 响应的完整对象）
   * @param ttlMs - 可选的生存时间（毫秒），超过后自动过期
   */
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/**
 * 内存缓存实现（默认）
 *
 * @description
 * 基于 Map 的内存缓存，支持 TTL 过期和 LRU 淘汰。
 * 适用于开发调试场景，进程退出后缓存自动清空。
 *
 * 淘汰策略：
 *   - TTL 过期：每次 get 时检查，每 100 次 set 批量清理
 *   - LRU 淘汰：缓存条目超过 500 时，淘汰最久未访问的 100 条
 */
class MemoryCache implements CacheStore {
  /** 内部存储，值包含：原始值、过期时间戳、最后访问时间戳 */
  private store = new Map<string, { value: unknown; expiresAt: number; lastAccessed: number }>();

  /**
   * 获取缓存值
   * @param key - 缓存键
   * @returns 命中返回缓存值，未命中或已过期返回 null
   */
  async get(key: string): Promise<unknown | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // 更新最后访问时间（LRU 追踪）
    entry.lastAccessed = Date.now();
    return entry.value;
  }

  /**
   * 设置缓存值
   * @param key - 缓存键
   * @param value - 要缓存的值
   * @param ttlMs - 生存时间（毫秒），默认 30 分钟
   */
  async set(key: string, value: unknown, ttlMs = 30 * 60 * 1000): Promise<void> {
    // 定期清理过期条目（每 100 次写入触发一次）
    if (this.store.size > 0 && this.store.size % 100 === 0) {
      const now = Date.now();
      for (const [k, v] of this.store) {
        if (now > v.expiresAt) this.store.delete(k);
      }
    }
    // 硬上限：超过 500 条目时按 LRU（最久未访问）淘汰
    if (this.store.size >= 500) {
      const lru = [...this.store.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
      for (let i = 0; i < 100 && i < lru.length; i++) {
        this.store.delete(lru[i][0]);
      }
    }
    const now = Date.now();
    this.store.set(key, { value, expiresAt: now + ttlMs, lastAccessed: now });
  }

  /** 清除所有缓存 */
  clear(): void {
    this.store.clear();
  }

  /** 获取当前缓存大小 */
  size(): number {
    return this.store.size;
  }
}

// ── 默认全局内存缓存实例 ──
const defaultCache = new MemoryCache();

/**
 * 获取默认缓存实例（用于手动清除等操作）
 * @returns 全局共享的 MemoryCache 单例
 */
export function getDefaultCache(): MemoryCache {
  return defaultCache;
}

// ── 缓存 key 生成 ──

/**
 * 根据请求参数生成缓存 key
 *
 * @description
 * 将请求参数对象序列化为 JSON 字符串作为缓存 key。
 * 如果序列化失败（如循环引用），返回一个随机 key，确保不会缓存该请求。
 *
 * @param params - LLM 请求参数对象
 * @returns 稳定的缓存 key 字符串
 */
function createCacheKey(params: Record<string, unknown>): string {
  // 序列化参数生成稳定的 key
  try {
    return JSON.stringify(params);
  } catch {
    // 如果序列化失败（循环引用等），返回随机 key（不缓存）
    return `uncacheable_${Date.now()}_${Math.random()}`;
  }
}

// ── 时间戳修复（JSON 序列化后 Date 变成 string）──

/**
 * 修复从缓存反序列化后的时间戳字段
 *
 * @description
 * JSON.stringify/parse 会将 Date 对象转换为 ISO 字符串。
 * 当从缓存中取出响应时，需要将 response.timestamp 从 string 恢复为 Date 对象，
 * 以确保调用方获得与原始响应一致的类型。
 *
 * @param obj - 从缓存反序列化的对象
 * @returns 修复时间戳后的对象（原地修改并返回）
 */
function fixTimestamps<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;

  const record = obj as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  if (response?.timestamp && typeof response.timestamp === 'string') {
    response.timestamp = new Date(response.timestamp);
  }

  return obj;
}

// ── 中间件工厂 ──

/**
 * 创建带有自定义缓存存储的中间件
 *
 * @description
 * 工厂函数，允许注入自定义缓存存储后端和配置参数。
 * 返回符合 AI SDK v6 LanguageModelV3Middleware 规范的中间件对象。
 *
 * @param options - 配置选项
 * @param options.store - 自定义缓存存储实现，默认使用内存缓存
 * @param options.ttlMs - 缓存生存时间（毫秒），默认 30 分钟
 * @param options.enabled - 是否启用缓存，默认仅非生产环境启用
 * @returns 配置好的缓存中间件实例
 *
 * @example
 * ```ts
 * // 使用 Redis 作为缓存后端
 * const cacheMiddleware = createCacheMiddleware({
 *   store: {
 *     get: (key) => redis.get(key),
 *     set: (key, value, ttl) => redis.set(key, JSON.stringify(value), 'PX', ttl),
 *   },
 *   ttlMs: 60 * 60 * 1000, // 1 小时
 * });
 * ```
 */
export function createCacheMiddleware(
  options: {
    store?: CacheStore;
    ttlMs?: number;
    /** 是否启用（默认：仅非生产环境启用） */
    enabled?: boolean;
  } = {},
): LanguageModelMiddleware {
  const {
    store = defaultCache,
    ttlMs = 30 * 60 * 1000,
    enabled = process.env.NODE_ENV !== 'production',
  } = options;

  if (!enabled) {
    // 不启用时返回空中间件
    return { specificationVersion: 'v3' as const };
  }

  return {
    specificationVersion: 'v3' as const,

    wrapGenerate: async ({ doGenerate, params }) => {
      const cacheKey = createCacheKey(params as unknown as Record<string, unknown>);
      const cached = await store.get(cacheKey);

      if (cached !== null) {
        if (process.env.DEBUG_CACHE === 'true') {
          console.log('[cache] HIT (generate)');
        }
        return fixTimestamps(cached) as Awaited<ReturnType<typeof doGenerate>>;
      }

      const result = await doGenerate();
      await store.set(cacheKey, result, ttlMs);

      if (process.env.DEBUG_CACHE === 'true') {
        console.log('[cache] MISS (generate) — cached');
      }
      return result;
    },

    // 流式调用直接透传，不做缓存
    // streamText 的流是实时消费的，缓存会导致流挂起
    wrapStream: async ({ doStream }) => {
      if (process.env.DEBUG_CACHE === 'true') {
        console.log('[cache] PASS (stream) — stream calls bypass cache');
      }
      return doStream();
    },
  };
}

/**
 * 默认缓存中间件实例
 *
 * @description
 * 使用内存缓存、30 分钟 TTL 的预配置中间件。
 * 可直接传入 AI SDK 的 middleware 配置中使用。
 * 在生产环境（NODE_ENV === 'production'）下自动禁用。
 */
export const cacheMiddleware: LanguageModelMiddleware = createCacheMiddleware();
