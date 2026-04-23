import { ethers } from "ethers";

interface UrlStats {
  failCount: number;
  lastCheck: number;
  avgResponseTime: number;
}

class RpcHealthPool {
  private healthyUrls: string[] = [];
  private unhealthyUrls: string[] = [];
  private currentIndex: number = 0;
  private urlStats: Map<string, UrlStats> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  
  private readonly TIMEOUT_MS = 5000; // 5 秒超时（避免网络波动导致误判）
  private readonly NORMAL_CHECK_INTERVAL_MS = 10000; // 全部健康时 10 秒检查一次
  private readonly FAST_CHECK_INTERVAL_MS = 5000; // 有不健康 RPC 时 5 秒检查一次

  constructor(urls: string[]) {
    // 初始化所有 URL 为健康状态
    this.healthyUrls = [...urls];
    urls.forEach(url => {
      this.urlStats.set(url, {
        failCount: 0,
        lastCheck: Date.now(),
        avgResponseTime: 0
      });
    });

    // 启动健康检查
    this.startHealthCheck();
    
    console.log(`✅ RPC 健康池初始化完成，共 ${urls.length} 个 URL`);
  }

  /**
   * 获取当前健康的 URL
   */
  getCurrentUrl(): string {
    if (this.healthyUrls.length === 0) {
      throw new Error('❌ 没有可用的健康 RPC URL');
    }
    
    // 确保索引在范围内
    if (this.currentIndex >= this.healthyUrls.length) {
      this.currentIndex = 0;
    }
    
    return this.healthyUrls[this.currentIndex];
  }

  /**
   * 标记当前 URL 为不健康并切换到下一个
   */
  markCurrentUnhealthy(reason: string): void {
    if (this.healthyUrls.length === 0) return;

    const currentUrl = this.healthyUrls[this.currentIndex];
    console.warn(`⚠️ 标记 RPC 为不健康: ${currentUrl}, 原因: ${reason}`);

    // 更新统计
    const stats = this.urlStats.get(currentUrl);
    if (stats) {
      stats.failCount++;
      stats.lastCheck = Date.now();
    }

    // 移到不健康池
    this.healthyUrls.splice(this.currentIndex, 1);
    this.unhealthyUrls.push(currentUrl);

    // 切换到下一个（如果还有的话）
    if (this.healthyUrls.length > 0) {
      this.currentIndex = this.currentIndex % this.healthyUrls.length;
      console.log(`🔄 切换到下一个 RPC: ${this.healthyUrls[this.currentIndex]}`);
    } else {
      console.error('❌ 所有 RPC URL 都不健康！');
    }
  }

  /**
   * Ping 一个 RPC URL
   */
  private async pingUrl(url: string): Promise<{ healthy: boolean; responseTime: number }> {
    const startTime = Date.now();
    try {
      const provider = new ethers.JsonRpcProvider(url);
      
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Ping timeout')), this.TIMEOUT_MS)
        )
      ]);

      const responseTime = Date.now() - startTime;
      return { healthy: true, responseTime };
    } catch (error) {
      return { healthy: false, responseTime: Date.now() - startTime };
    }
  }

  /**
   * 检查所有 URL 的健康状态
   */
  private async checkAllUrls(): Promise<void> {
    // 检查健康池中的 URL（确保仍然健康）
    const healthyChecks = this.healthyUrls.map(async (url) => {
      const result = await this.pingUrl(url);
      
      const stats = this.urlStats.get(url);
      if (stats) {
        stats.lastCheck = Date.now();
        stats.avgResponseTime = result.responseTime;
      }

      if (!result.healthy) {
        console.warn(`⚠️ 健康池中的 RPC 变为不健康: ${url}`);
        const index = this.healthyUrls.indexOf(url);
        if (index !== -1) {
          this.healthyUrls.splice(index, 1);
          this.unhealthyUrls.push(url);
          if (stats) stats.failCount++;
        }
      }
    });

    // 检查不健康池中的 URL（尝试恢复）
    const unhealthyChecks = this.unhealthyUrls.map(async (url) => {
      const result = await this.pingUrl(url);
      
      const stats = this.urlStats.get(url);
      if (stats) {
        stats.lastCheck = Date.now();
        stats.avgResponseTime = result.responseTime;
      }

      if (result.healthy) {
        console.log(`✅ RPC 恢复健康: ${url}`);
        const index = this.unhealthyUrls.indexOf(url);
        if (index !== -1) {
          this.unhealthyUrls.splice(index, 1);
          this.healthyUrls.push(url);
          if (stats) stats.failCount = 0;
        }
      }
    });

    await Promise.all([...healthyChecks, ...unhealthyChecks]);
  }

  /**
   * 启动定时健康检查（动态间隔）
   */
  private startHealthCheck(): void {
    const runCheck = async () => {
      console.log('🔍 开始 RPC 健康检查...');
      await this.checkAllUrls();
      
      // 动态调整检查间隔
      const nextInterval = this.unhealthyUrls.length > 0 
        ? this.FAST_CHECK_INTERVAL_MS  // 有不健康 RPC，3 秒后再检查
        : this.NORMAL_CHECK_INTERVAL_MS; // 全部健康，6 秒后检查
      
      const nextCheckSeconds = nextInterval / 1000;
      console.log(`📊 健康: ${this.healthyUrls.length}, 不健康: ${this.unhealthyUrls.length} (${nextCheckSeconds}秒后再检查)`);
      
      this.healthCheckInterval = setTimeout(runCheck, nextInterval);
    };
    
    // 立即执行第一次检查
    runCheck();
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearTimeout(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * 获取健康池状态
   */
  getStatus() {
    return {
      healthy: this.healthyUrls,
      unhealthy: this.unhealthyUrls,
      current: this.getCurrentUrl(),
      stats: Object.fromEntries(this.urlStats)
    };
  }
}

// 全局单例
let healthPool: RpcHealthPool | null = null;

/**
 * 初始化 RPC 健康池
 */
export function initRpcHealthPool(urls: string[]): void {
  if (!healthPool) {
    healthPool = new RpcHealthPool(urls);
  }
}

/**
 * 获取 RPC 健康池实例
 */
export function getRpcHealthPool(): RpcHealthPool {
  if (!healthPool) {
    throw new Error('RPC 健康池未初始化，请先调用 initRpcHealthPool()');
  }
  return healthPool;
}
