/**
 * 基础应用错误类
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 参数验证错误（400）
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

/**
 * 签名验证失败（400）
 */
export class InvalidSignatureError extends AppError {
  constructor(message: string = '签名验证失败') {
    super('INVALID_SIGNATURE', message, 400);
  }
}

/**
 * 不是 Safe owner（403）
 */
export class NotOwnerError extends AppError {
  constructor(userAddress: string, owners: string[]) {
    super(
      'NOT_SAFE_OWNER',
      `用户 ${userAddress} 不是 Safe 的 owner`,
      403,
      { userAddress, owners }
    );
  }
}

/**
 * Safe 未部署（404）
 */
export class SafeNotDeployedError extends AppError {
  constructor(safeAddress: string) {
    super(
      'SAFE_NOT_DEPLOYED',
      `Safe ${safeAddress} 尚未部署`,
      404,
      { safeAddress }
    );
  }
}

/**
 * RPC 网络错误（502）
 */
export class RpcError extends AppError {
  constructor(message: string = '网络异常，请稍后重试', details?: any) {
    super('RPC_ERROR', message, 502, details);
  }
}

/**
 * 队列错误（500）
 */
export class QueueError extends AppError {
  constructor(message: string, details?: any) {
    super('QUEUE_ERROR', message, 500, details);
  }
}

/**
 * Nonce 错误（500）
 */
export class NonceError extends AppError {
  constructor(message: string, details?: any) {
    super('NONCE_ERROR', message, 500, details);
  }
}

/**
 * Gas 估算失败（500）
 */
export class GasEstimationError extends AppError {
  constructor(message: string = 'Gas 估算失败', details?: any) {
    super('GAS_ESTIMATION_ERROR', message, 500, details);
  }
}
