import logger from './logger.js';

/**
 * 必需的环境变量
 */
const REQUIRED_ENV_VARS = [
  'PRIVATE_KEY',
  'REDIS_PASSWORD',
  'REDIS_CLUSTER_NODES'
];

/**
 * 验证环境变量
 */
export function validateEnv(): void {
  const missing: string[] = [];
  
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }
  
  if (missing.length > 0) {
    logger.error('❌ 缺少必需的环境变量', { missing });
    logger.error('请在 .env 文件中配置以下环境变量:');
    missing.forEach(key => {
      logger.error(`  - ${key}`);
    });
    process.exit(1);
  }
  
  // 验证 PRIVATE_KEY 格式（支持有无 0x 前缀）
  const privateKey = process.env.PRIVATE_KEY!;
  const keyWithoutPrefix = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  
  if (keyWithoutPrefix.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(keyWithoutPrefix)) {
    logger.error('❌ PRIVATE_KEY 格式错误', {
      expected: '64 个十六进制字符（可选 0x 前缀）',
      actual: `长度 ${privateKey.length}`
    });
    process.exit(1);
  }
  
  logger.info('✅ 环境变量验证通过');
}
