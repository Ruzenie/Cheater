/**
 * cache.ts — LLM 响应缓存中间件
 *
 * 基于参数 hash 缓存 generateText 的完整响应。
 * 开发/调试时可大幅减少 API 调用和成本。
 *
 * 使用 AI SDK v6 LanguageModelV3Middleware 规范：
 *   - wrapGenerate: 缓存 doGenerate 完整结果
 *   - wrapStream:   直接透传（流式缓存会导致流挂起，暂不支持）
 *
 * 默认使用内存 Map 缓存，可通过 createCacheMiddleware 注入外部存储。
 */

import type { LanguageModelMiddleware } from 'ai';

// ── 缓存接口（可扩展为 Redis/文件/IndexedDB）──

export interface CacheStore {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlMs?: number): Promise<void>;
}

/** 内存缓存（默认） */
class MemoryCache implements CacheStore {
  private store = new Map<string, { value: any; expiresAt: number; lastAccessed: number }>();

  async get(key: string): Promise<any | null> {
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

  async set(key: string, value: any, ttlMs = 30 * 60 * 1000): Promise<void> {
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

// 默认全局内存缓存
const defaultCache = new MemoryCache();

/** 获取默认缓存实例（用于手动清除等操作） */
export function getDefaultCache(): MemoryCache {
  return defaultCache;
}

// ── 缓存 key 生成 ──

function createCacheKey(params: any): string {
  // 序列化参数生成稳定的 key
  try {
    return JSON.stringify(params);
  } catch {
    // 如果序列化失败（循环引用等），返回随机 key（不缓存）
    return `uncacheable_${Date.now()}_${Math.random()}`;
  }
}

// ── 时间戳修复（JSON 序列化后 Date 变成 string）──

function fixTimestamps(obj: any): any {
  if (!obj) return obj;

  if (obj.response?.timestamp && typeof obj.response.timestamp === 'string') {
    obj.response.timestamp = new Date(obj.response.timestamp);
  }

  return obj;
}

// ── 中间件工厂 ──

/**
 * 创建带有自定义缓存存储的中间件
 *
 * @example
 * ```ts
 * // 使用 Redis
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
      const cacheKey = createCacheKey(params);
      const cached = await store.get(cacheKey);

      if (cached !== null) {
        if (process.env.DEBUG_CACHE === 'true') {
          console.log('[cache] HIT (generate)');
        }
        return fixTimestamps(cached);
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

/** 默认缓存中间件实例（使用内存缓存） */
export const cacheMiddleware: LanguageModelMiddleware = createCacheMiddleware();
