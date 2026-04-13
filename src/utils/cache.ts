/**
 * 简单的内存缓存工具
 */
import logger from './logger.js';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();

  /**
   * 设置缓存
   */
  set<T>(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, {
      data,
      expiry: Date.now() + ttlMs
    });
  }

  /**
   * 获取缓存
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * 删除缓存
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 清理过期缓存（定期调用）
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}

// 全局缓存实例
export const cache = new MemoryCache();

// 定期清理过期缓存（每 5 分钟）
setInterval(() => {
  const cleaned = cache.cleanup();
  if (cleaned > 0) {
    logger.info(`🧹 清理过期缓存`, { cleaned, remaining: cache.size() });
  }
}, 5 * 60 * 1000);

// 缓存 TTL 配置
export const CACHE_TTL = {
  SAFE_OWNERS: 5 * 60 * 1000,    // 5 分钟
  GAS_PRICE: 10 * 1000,          // 10 秒
};
