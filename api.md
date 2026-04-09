# Safe Relayer API 文档

## 基础信息

- **Base URL**: `http://localhost:9527`
- **Content-Type**: `application/json`

---

## 1. 健康检查

### 1.1 基础健康检查

**接口**: `/`

**方法**: `GET`

**说明**: 检查 Relayer 服务是否运行

**返回**:
```
Relayer is running 🚀
```

---

### 1.2 详细健康检查

**接口**: `/health`

**方法**: `GET`

**说明**: 获取 Relayer 服务详细状态

**返回**:
```json
{
  "status": "ok",
  "version": "v1.0.0",
  "timestamp": 1712563200000
}
```

---

## 2. Safe 钱包部署

### 2.1 获取 Safe 地址

**接口**: `/api/v1/get-safe-address`

**方法**: `POST`

**说明**: 根据用户 EOA 地址预测 Safe 钱包地址

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| userAddress | string | 是 | 用户的 EOA 地址 |

**示例**:
```json
{
  "userAddress": "0xb6d27e61caa3a7e8f6615ae43099c7e8fbfdb582"
}
```

**返回**:
```json
{
  "success": true,
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "isDeployed": false
}
```

**返回字段说明**:
- `success`: 请求是否成功
- `safeAddress`: 预测的 Safe 钱包地址
- `isDeployed`: Safe 是否已部署

---

### 2.2 准备部署交易

**接口**: `/api/v1/prepare-deployment`

**方法**: `POST`

**说明**: 为前端准备 Safe 部署交易数据（用于预览）

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| userAddress | string | 是 | 用户的 EOA 地址 |

**示例**:
```json
{
  "userAddress": "0xb6d27e61caa3a7e8f6615ae43099c7e8fbfdb582"
}
```

**返回**:
```json
{
  "success": true,
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "deploymentTx": {
    "to": "0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC",
    "value": "0",
    "data": "0x1688f0b9...",
    "operation": 0
  }
}
```

---

### 2.3 部署 Safe 钱包

**接口**: `/api/v1/deploy-safe`

**方法**: `POST`

**说明**: Relayer 代付 gas 部署 Safe 钱包

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| userAddress | string | 是 | 用户的 EOA 地址（Safe owner） |

**示例**:
```json
{
  "userAddress": "0xb6d27e61caa3a7e8f6615ae43099c7e8fbfdb582"
}
```

**返回**:
```json
{
  "success": true,
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "txHash": "0xc211c95d99f96d3d1885ede792546509b5e48b5a8085b9ba827f22819b6db720"
}
```

**返回字段说明**:
- `success`: 部署是否成功
- `safeAddress`: 部署的 Safe 钱包地址
- `txHash`: 部署交易哈希

**注意事项**:
- 交易发送后立即返回，不等待区块确认
- 前端需要自行轮询查询交易状态

---

## 3. Safe 交易准备

### 3.1 准备交易（不收费）。除了转账以外都是走的这个接口

**接口**: `/api/v1/prepare-transaction`

**方法**: `POST`

**说明**: 准备 Safe 交易，返回 safeTxHash 供前端签名（不收取 ERC20 手续费）

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| safeAddress | string | 是 | Safe 钱包地址 |
| to | string | 是 | 目标地址 |
| value | string | 否 | 转账金额（wei），默认 "0" |
| data | string | 是 | 交易数据（hex） |

**示例**:
```json
{
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "to": "0x63dc899e65d6dfd5782a342f1d755abb3ef88081",
  "value": "0",
  "data": "0xa9059cbb000000000000000000000000df893ff798f398ba5e5d1c5e01cf55f57847cf1b0000000000000000000000000000000000000000000000004563918244f40000"
}
```

**返回**:
```json
{
  "success": true,
  "safeTxHash": "0x2151e4f21e9f729638a178fbb5369fc9b190d923fd67879c5af5dd26248e3fdc",
  "safeTransaction": {
    "to": "0x63dc899e65d6dfd5782a342f1d755abb3ef88081",
    "value": "0",
    "data": "0xa9059cbb...",
    "operation": 0,
    "safeTxGas": "0",
    "baseGas": "0",
    "gasPrice": "0",
    "gasToken": "0x0000000000000000000000000000000000000000",
    "refundReceiver": "0x0000000000000000000000000000000000000000",
    "nonce": "7"
  }
}
```

**返回字段说明**:
- `safeTxHash`: Safe 交易哈希，前端用此签名
- `safeTransaction`: 完整的 Safe 交易参数，前端签名后需传回

---

### 3.2 准备交易（收费） 只有交易transfer方法走这个接口

**接口**: `/api/v1/prepare-transaction`

**方法**: `POST`

**说明**: 准备 Safe 交易并计算 ERC20 手续费，返回 safeTxHash 供前端签名

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| safeAddress | string | 是 | Safe 钱包地址 |
| to | string | 是 | 目标地址 |
| value | string | 否 | 转账金额（wei），默认 "0" |
| data | string | 是 | 交易数据（hex） |

**示例**:
```json
{
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "to": "0x63dc899e65d6dfd5782a342f1d755abb3ef88081",
  "value": "0",
  "data": "0xa9059cbb000000000000000000000000df893ff798f398ba5e5d1c5e01cf55f57847cf1b0000000000000000000000000000000000000000000000004563918244f40000"
}
```

**返回**:
```json
{
  "success": true,
  "safeTxHash": "0x2151e4f21e9f729638a178fbb5369fc9b190d923fd67879c5af5dd26248e3fdc",
  "estimatedFee": "0.1",
  "estimatedFeeWei": "100000000000000000",
  "gasTokenAddress": "0x63Dc899e65d6dFD5782a342f1d755aBb3ef88081",
  "safeTransaction": {
    "to": "0x63dc899e65d6dfd5782a342f1d755abb3ef88081",
    "value": "0",
    "data": "0xa9059cbb...",
    "operation": 0,
    "safeTxGas": "51913",
    "baseGas": "21000",
    "gasPrice": "1371497538161",
    "gasToken": "0x63Dc899e65d6dFD5782a342f1d755aBb3ef88081",
    "refundReceiver": "0xdf893ff798f398ba5e5d1c5e01cf55f57847cf1b",
    "nonce": "7"
  }
}
```

**返回字段说明**:
- `safeTxHash`: Safe 交易哈希，前端用此签名
- `estimatedFee`: 预计手续费（可读格式，如 "0.1"）
- `estimatedFeeWei`: 预计手续费（wei）
- `gasTokenAddress`: 收费代币地址
- `safeTransaction`: 完整的 Safe 交易参数（包含收费信息），前端签名后需传回

**注意事项**:
- Safe 钱包需要有足够的 ERC20 代币余额支付手续费
- 手续费会自动从 Safe 钱包扣除并转给 Relayer

---

## 4. Safe 交易执行

### 4.1 执行 Safe 交易

**接口**: `/api/v1/execute`

**方法**: `POST`

**说明**: Relayer 代付 gas 执行 Safe 交易

**参数说明**:

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| safeAddress | string | 是 | Safe 钱包地址 |
| safeTransaction | object | 是 | Safe 交易参数（从 prepare 接口返回） |
| signature | string | 是 | 用户签名（hex） |
| userAddress | string | 是 | 用户地址（签名者） |

**safeTransaction 字段说明**:

| 字段名 | 类型 | 说明 |
|--------|------|------|
| to | string | 目标地址 |
| value | string | 转账金额（wei） |
| data | string | 交易数据（hex） |
| operation | number | 操作类型（0=Call, 1=DelegateCall） |
| safeTxGas | string | Safe 交易 gas 限制 |
| baseGas | string | 基础 gas |
| gasPrice | string | Gas 价格 |
| gasToken | string | 收费代币地址 |
| refundReceiver | string | 手续费接收地址 |
| nonce | string | Safe 交易 nonce |

**示例**:
```json
{
  "safeAddress": "0xdFDe88d51467c46185d9F3C7F9BA3Fb46c5eFc1B",
  "safeTransaction": {
    "to": "0x63dc899e65d6dfd5782a342f1d755abb3ef88081",
    "value": "0",
    "data": "0xa9059cbb000000000000000000000000df893ff798f398ba5e5d1c5e01cf55f57847cf1b0000000000000000000000000000000000000000000000004563918244f40000",
    "operation": 0,
    "safeTxGas": "51913",
    "baseGas": "21000",
    "gasPrice": "1371497538161",
    "gasToken": "0x63Dc899e65d6dFD5782a342f1d755aBb3ef88081",
    "refundReceiver": "0xdf893ff798f398ba5e5d1c5e01cf55f57847cf1b",
    "nonce": "7"
  },
  "signature": "0x92aff5590b8fd4b3524b0831c45f04e59d7b2ef595310c86a4170dc3e5df23871a629587494cf86a3a652636779138c983dc431352fbdfcb1dd2717768bf22961c",
  "userAddress": "0xb6d27e61caa3a7e8f6615ae43099c7e8fbfdb582"
}
```

**返回**:
```json
{
  "success": true,
  "txHash": "0x11c68d048244d72b3a3e29fa5e4ee869a315a40a3098813edec68336ed418206"
}
```

**返回字段说明**:
- `success`: 执行是否成功
- `txHash`: 交易哈希

**注意事项**:
- 交易发送后立即返回，不等待区块确认
- 前端需要自行轮询查询交易状态
- 用户必须是 Safe 的 owner
- 签名必须与 safeTxHash 匹配

---

## 5. 错误码

| HTTP 状态码 | 说明 |
|------------|------|
| 200 | 请求成功 |
| 400 | 参数错误 |
| 500 | 服务器内部错误 |

**错误返回格式**:
```json
{
  "success": false,
  "error": "错误信息"
}
```

---

## 6. 配置信息

### 6.1 网络配置

- **Chain ID**: 84532 (Base Sepolia)

---

## 7. 前端集成示例

### 7.1 部署 Safe 钱包

```javascript
// 1. 获取 Safe 地址
const { safeAddress, isDeployed } = await fetch('/api/v1/get-safe-address', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userAddress: '0x...' })
}).then(res => res.json());

// 2. 如果未部署，则部署
if (!isDeployed) {
  const { txHash } = await fetch('/api/v1/deploy-safe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userAddress: '0x...' })
  }).then(res => res.json());
  
  // 3. 轮询查询部署状态
  const checkDeployment = async () => {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      setTimeout(checkDeployment, 2000);
      return;
    }
    console.log('Safe 部署成功！');
  };
  checkDeployment();
}
```

### 7.2 执行 Safe 交易

```javascript
// 1. 准备交易
const { safeTxHash, safeTransaction, estimatedFee } = await fetch('/api/v1/prepare-transaction', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    safeAddress: '0x...',
    to: '0x...',
    value: '0',
    data: '0x...'
  })
}).then(res => res.json());

// 2. 用户签名
const signature = await wallet.signMessage(ethers.getBytes(safeTxHash));

// 3. 执行交易
const { txHash } = await fetch('/api/v1/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    safeAddress: '0x...',
    safeTransaction: safeTransaction,
    signature: signature,
    userAddress: wallet.address
  })
}).then(res => res.json());

// 4. 轮询查询交易状态
const checkTransaction = async () => {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    setTimeout(checkTransaction, 2000);
    return;
  }
  if (receipt.status === 1) {
    console.log('交易成功！');
  } else {
    console.log('交易失败！');
  }
};
checkTransaction();
```

---

## 8. 注意事项

1. **所有交易都是异步的**：接口返回 txHash 后不等待区块确认，前端需要自行轮询查询状态
2. **签名顺序很重要**：本地准好好交易数据后，再签名，最后调用 `/execute`，如果是转账接口需要先调用 `/prepare-transaction-with-fee`再调用 `/execute`
3. **手续费要求**：如果使用收费模式，Safe 钱包必须有足够的 ERC20 代币余额(>0.1)
4. **网络要求**：当前仅支持 Base Sepolia 测试网
