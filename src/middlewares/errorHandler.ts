import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { errorResponse } from '../utils/response.js';
import logger from '../utils/logger.js';

/**
 * 全局错误处理中间件
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 记录错误日志
  logger.error('❌ 请求错误', {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    body: req.body,
    ip: req.ip
  });

  // 如果是自定义错误
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(
      errorResponse(err.code, err.message, err.details)
    );
  }

  // 处理 JSON 解析错误
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json(
      errorResponse('INVALID_JSON', 'JSON 格式错误')
    );
  }

  // 未知错误（500）
  return res.status(500).json(
    errorResponse(
      'INTERNAL_ERROR',
      process.env.NODE_ENV === 'production' 
        ? '服务器内部错误' 
        : err.message
    )
  );
}
