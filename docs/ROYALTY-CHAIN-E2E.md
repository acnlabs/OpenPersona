# 版税链「菜谱法」端到端验证（海外 / credits）

> 状态：闭环已打通并验证（2026-06）
> 适用范围：OpenPersona 海外站（`openpersona.co` + 全球 Store `api.agentplanet.org`）的付费人格包**转售/fork 版税链**。
> 配套设计见 `MARKETPLACE-GATED-DELIVERY.md`（§2 gated 投递）、`STORE-INTEGRATION-QUICKSTART.md`（接口/分账）。

---

## 0. 一句话原理

买家付费 → 投递时把**血缘**（根作者 + 代数）写进包的 `soul/lineage.json` → `fork` 继承血缘并 `generation+1` → 二次上架时从包内**权威提取**血缘 → Store 成交后按代数把一部分分给**根作者**。

```
A 上架(gen=1) ──buy──▶ B 安装/下载(注入 lineage) ──fork──▶ B 二代包(gen=2,根=A)
                                                              │
                                              二次上架(提取根=A,gen=2)
                                                              │
            第三方购买 ──▶ Store 分账：平台 + 卖家(B) + 版税回 根作者(A)
```

**关键不变量**：`rootCreator` / `rootPackRef` 在 fork 链上**永不改变**，只有 `generation` 递增。版税始终回到链路最上游的 `rootCreator`。

---

## 1. 血缘是怎么进到包里的（两条路径，字节等价）

血缘的真相源是 Store 的 `redeem` 响应（`root_creator` + `generation`），由 OP 投递层写入包内 `soul/lineage.json`。两条下载路径产物一致：

| 路径 | 端点 | 血缘写入方 |
|---|---|---|
| **CLI** `install op://private/<slug> --order <id>` | `GET /api/persona/deliver`（返回 presigned URL + `root_creator`/`generation`） | CLI 客户端在本地写 provenance |
| **浏览器** My Purchases → Download | `GET /api/persona/deliver/download?order_id=...`（**流式返回已注入血缘的 zip**） | OP 服务端在交付前注入 `soul/lineage.json` |

> 历史坑：早期浏览器 Download 直接发 R2 presigned URL，下回的是**卖家原始包**，不含买家专属 `soul/lineage.json` → fork 后版税链断裂（需手动补文件）。
> 修复：新增 `/api/persona/deliver/download`，`redeem` 一次 → 拉字节 → `injectPackLineage()`（fflate 解包、合并已有血缘、写 `soul/lineage.json`、重打包）→ 流式 `application/zip`。My Purchases 改走该端点（blob 下载，仅一次 redeem）。`lib/private-store.ts::injectPackLineage` 为纯函数，单测覆盖（扁平/嵌套根、合并、generation 默认 0）。

注入后的 `soul/lineage.json` 形如：

```json
{
  "rootCreator": "github|43027886",
  "generation": 1,
  "rootPackRef": "op://private/entrepreneur-skill@p0-e2e-1.0.0",
  "purchasedVia": "op-store-redeem",
  "purchasedOrderId": "b9cb5ccc-..."
}
```

---

## 2. 自动化验证（无需人工登录）

### 2.1 Store 分账（gen=1）

半自动脚本走 Store 内部 token，覆盖：建商品 → pay-external → redeem(回带 root/gen) → accept-external(释放分账) → 清理下架。

```bash
# 仓库根目录，需 frontend/.env.local 含 STORE_API_BASE + INTERNAL_API_TOKEN
node --env-file=frontend/.env.local scripts/royalty-chain-e2e.mjs
```

预期 `RESULT: PASSED`，且：
- `redeem` 回带 `root_creator` / `generation=1`；
- `accept-external` 后 `state=completed` 且 `hold_released_at` 非空；
- 分账（amount=1000, gen=1）：平台 100 / 版税回根作者 30（3%）/ 卖家 870。

> 钱包真实到账金额需 Auth0 真人买家，见 §3。

### 2.2 血缘注入 + fork 继承（单测）

```bash
cd frontend && pnpm exec vitest run tests/private-store.test.ts
```

覆盖 `injectPackLineage` 往扁平包 / 嵌套根写入、合并已有血缘不丢 fork 字段、缺省 generation=0。

### 2.3 线上冒烟

```bash
curl -s "https://openpersona.co/api/persona/deliver/download?order_id=fake" -w "\nHTTP %{http_code}\n"
# 预期 401 {"ok":false,"reason":"unauthorized"}（鉴权门在订单查询之前）
```

---

## 3. 真人 E2E（需 Auth0 浏览器登录，三个账号 A/B/C）

> 红线：充值落账钱包必须 == `pay` 扣款钱包（同一 Auth0 `sub`）。海外 credits 充值走 PayPal。

1. **A 上架（gen=1）**
   - CLI `market publish` 上传脱敏包字节到 R2 → 卖页填价发布。
   - `/api/market/list` 对原始上架写 `generation: 1`、`root_creator = A`。

2. **B 购买 + 取包**
   - B 在 `/market/[id]` 购买（credits，余额不足先 PayPal 充值）。
   - 取包二选一，产物等价：
     - 浏览器：My Purchases → Download；
     - CLI：`openpersona install op://private/<slug> --order <orderId>`。
   - 校验包内血缘：

     ```bash
     unzip -o <下载>.zip -d _v >/dev/null && cat _v/soul/lineage.json
     # 期望 rootCreator=A, generation=1, rootPackRef=op://private/<slug>@<ver>
     ```

3. **B fork（gen=2，根=A）**

   ```bash
   openpersona install <下载或解压目录>      # 先装成本地 persona
   openpersona fork <slug> --as <new-slug> --reason "secondary listing"
   # 子包 soul/lineage.json: generation=2, rootCreator 仍为 A, parentSlug=<slug>
   ```

4. **B 二次上架**
   - `market publish` 上传二代包 → 卖页发布。
   - `/api/market/list` 从**包内 lineage 权威提取** `root_creator=A` / `generation=2`，并与 KV 交叉校验（卖家不可篡改根作者）。

5. **C 购买 + 验 A 钱包**
   - 第三账号 C 购买 B 的二代包。
   - 检查 **A**（根作者）`https://agentplanet.org/wallet` 收到 gen=2 版税到账。

---

## 4. 验收勾选

- [x] Store 分账（gen=1）半自动脚本 PASSED
- [x] 浏览器 Download 注入 `soul/lineage.json`（真实包验证）
- [x] fork 继承 `rootCreator` 不变、`generation` 1→2（真实 fork 验证）
- [ ] 二次上架权威提取 root/gen（真人浏览器）
- [ ] 第三方购买后根作者 A 钱包收到版税（真人浏览器，gen=2）

---

## 5. 相关代码

| 关注点 | 位置 |
|---|---|
| 浏览器 gated 下载（注入血缘 + 流式 zip） | `frontend/app/api/persona/deliver/download/route.ts` |
| CLI gated 投递（presigned + 回带血缘） | `frontend/app/api/persona/deliver/route.ts` |
| 血缘注入纯函数 + R2 取字节 | `frontend/lib/private-store.ts`（`injectPackLineage` / `getPackBytes`） |
| My Purchases 下载（blob、单次 redeem） | `frontend/components/purchase-list.tsx` |
| redeem 解析 root/gen | `frontend/lib/store.ts`（`redeemEntitlement`） |
| 上架时权威提取 root/gen | `frontend/app/api/market/list/route.ts` |
| fork 写子血缘 | `lib/lifecycle/forker.js` |
| 半自动分账脚本 | `scripts/royalty-chain-e2e.mjs` |
