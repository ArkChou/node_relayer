import express from "express";

const app = express();
const PORT = 9527;

// 解析 JSON
app.use(express.json());

/**
 * 健康检查
 */
app.get("/", (req, res) => {
  res.send("Relayer is running 🚀");
});

/**
 * 接受初始化账户请求
 */
app.post("/initialAccount", async (req, res) => {
  try {
    const { safeAddress, safeTx, signature } = req.body;

    console.log("收到请求:");
    console.log("safeAddress:", safeAddress);
    console.log("safeTx:", safeTx);
    console.log("signature:", signature);

    // TODO: 后面你在这里做：
    // 1. 验签
    // 2. nonce 检查
    // 3. 调 Safe.execTransaction

    return res.json({
      success: true,
      message: "收到请求（还没执行）"
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 接受发送交易请求
 */
app.post("/sendTransaction", async (req, res) => {
  try {
    const { safeAddress, safeTx, signature } = req.body;

    return res.json({
      success: true,
      message: "收到请求（还没执行）"
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 启动服务
 */
app.listen(PORT, () => {
  console.log(`🚀 Relayer running on http://localhost:${PORT}`);
});