import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * 请求日志中间件
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  // 记录请求开始
  logger.info(`📥 ${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    body: req.method === 'POST' ? req.body : undefined
  });

  // 监听响应完成
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[level](`📤 ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
}
