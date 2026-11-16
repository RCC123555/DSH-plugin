# hardware-quote price-memory

1688 物料价格记忆（由 DSH hardware-quote 插件自动维护，请勿手工改结构）。

- `search/<sha256>.json`：关键词 / 以图搜款候选结果
- `offer/<offerId>.json`：详情页 SKU、阶梯价、供应商等抽取结果

每个文件字段：`schemaVersion`、`kind`、`key`、`capturedAt`、`storedAt`、`source`、`payload`。
只缓存真实抓取成功的结果；登录墙、验证码、空结果不入库。
超过 180 天的记录由插件在查询时重新抓取并覆盖。

价格数据来自 1688 等公开商品页，不包含账号、Cookie、聊天或截图。
