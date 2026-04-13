/**
 * 成功响应格式
 */
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  timestamp: number;
}

/**
 * 错误响应格式
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: number;
}

/**
 * 创建成功响应
 */
export function successResponse<T>(data: T): SuccessResponse<T> {
  return {
    success: true,
    data,
    timestamp: Date.now()
  };
}

/**
 * 创建错误响应
 */
export function errorResponse(
  code: string,
  message: string,
  details?: any
): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      // 生产环境不返回详细错误信息
      details: process.env.NODE_ENV === 'production' ? undefined : details
    },
    timestamp: Date.now()
  };
}
