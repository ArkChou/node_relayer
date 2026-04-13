# 消息队列使用指南

## 📋 概述

系统已升级为异步队列模式，提升并发处理能力和稳定性。

---

## 🚀 前端调用方式

### **1. 提交交易（异步）**

```dart
final url = 'http://your-server-ip:9525/api/v1/execute-transaction';

final response = await http.post(
  Uri.parse(url),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode({
    'safeAddress': safeAddress,
    'safeTransaction': safeTransaction,
    'signature': signature,
    'userAddress': userAddress,
    'safeTxHash': safeTxHash,
  }),
);

final result = jsonDecode(response.body);

if (result['success']) {
  final jobId = result['jobId'];  // 保存任务 ID
  print('任务已入队: $jobId');
  
  // 开始轮询查询状态
  pollJobStatus(jobId);
}
```

---

### **2. 查询任务状态（轮询）**

```dart
Future<void> pollJobStatus(String jobId) async {
  final url = 'http://your-server-ip:9525/api/v1/transaction/$jobId';
  
  while (true) {
    await Future.delayed(Duration(seconds: 2));  // 每 2 秒查询一次
    
    final response = await http.get(Uri.parse(url));
    final result = jsonDecode(response.body);
    
    if (result['success']) {
      final state = result['state'];
      
      switch (state) {
        case 'waiting':
          print('⏳ 等待处理...');
          break;
        case 'active':
          print('🔄 正在执行...');
          break;
        case 'completed':
          print('✅ 交易成功！');
          final txHash = result['result']['txHash'];
          print('交易哈希: $txHash');
          return;  // 完成，退出轮询
        case 'failed':
          print('❌ 交易失败: ${result['failedReason']}');
          return;  // 失败，退出轮询
      }
    }
  }
}
```

---

## 📊 任务状态说明

| 状态 | 说明 |
|------|------|
| `waiting` | 在队列中等待 |
| `active` | 正在执行 |
| `completed` | 执行成功 |
| `failed` | 执行失败 |

---

## 🔧 配置说明

### **Worker 并发数**

`src/queue/worker.ts`:
```typescript
const CONCURRENCY = 5;  // 每个实例 5 个并发
```

**3 个实例 × 5 并发 = 15 个任务同时执行**

### **调整建议**

| 并发配置 | 吞吐量 | RPC 压力 | 推荐场景 |
|---------|--------|---------|---------|
| 3 × 3 = 9 | 6 笔/秒 | 28% | 低并发 |
| 3 × 5 = 15 | 10 笔/秒 | 47% | **推荐** |
| 3 × 7 = 21 | 14 笔/秒 | 66% | 高并发 |

---

## 🎯 性能指标

### **20 并发测试**

- ✅ 接受率：100%（全部入队）
- ✅ 完成时间：2-3 秒
- ✅ 成功率：95%+
- ✅ RPC 使用率：47%

---

## 🛠️ 运维命令

### **查看队列状态**

```bash
# 进入容器
docker exec -it relayer-1 sh

# 在 Node.js REPL 中
node
> const Queue = require('bull');
> const queue = new Queue('safe-transactions', { redis: { host: 'redis-node-1', port: 6379 } });
> queue.getWaitingCount().then(console.log);  // 等待中的任务
> queue.getActiveCount().then(console.log);   // 执行中的任务
> queue.getCompletedCount().then(console.log); // 已完成的任务
> queue.getFailedCount().then(console.log);   // 失败的任务
```

### **清空队列**

```bash
> queue.clean(0, 'completed');  // 清空已完成的任务
> queue.clean(0, 'failed');     // 清空失败的任务
> queue.empty();                // 清空所有等待的任务
```

---

## ⚠️ 注意事项

1. **前端需要改为轮询模式**（不再是同步等待）
2. **保存 jobId**（用于查询状态）
3. **轮询间隔建议 2 秒**（不要太频繁）
4. **超时处理**（如 30 秒后仍未完成，提示用户）

---

## 🚀 优势

- ✅ 支持更高并发（20+ req/s）
- ✅ 不会因 Nginx 限流拒绝请求
- ✅ 失败自动重试（最多 3 次）
- ✅ 任务持久化（重启不丢失）
- ✅ 更好的监控和日志
