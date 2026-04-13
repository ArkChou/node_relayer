import { ethers } from 'ethers';
import { ValidationError } from './errors.js';

/**
 * 验证以太坊地址格式
 */
export function validateAddress(address: string, fieldName: string = '地址'): void {
  if (!address) {
    throw new ValidationError(`${fieldName}不能为空`);
  }
  
  if (!ethers.isAddress(address)) {
    throw new ValidationError(`无效的${fieldName}格式`, { address });
  }
}

/**
 * 验证签名格式
 */
export function validateSignature(signature: string): void {
  if (!signature) {
    throw new ValidationError('签名不能为空');
  }
  
  // 签名格式：0x + 130 个十六进制字符（65 字节）
  if (!signature.match(/^0x[a-fA-F0-9]{130}$/)) {
    throw new ValidationError('无效的签名格式', { 
      signature,
      expected: '0x + 130 个十六进制字符'
    });
  }
}

/**
 * 验证必需参数
 */
export function validateRequired(params: Record<string, any>, requiredFields: string[]): void {
  const missing: string[] = [];
  
  for (const field of requiredFields) {
    if (!params[field]) {
      missing.push(field);
    }
  }
  
  if (missing.length > 0) {
    throw new ValidationError('缺少必需参数', { 
      missing,
      required: requiredFields
    });
  }
}
