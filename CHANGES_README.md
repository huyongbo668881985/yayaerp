# P0/P1 修复 + 试用注册接入阿里云短信 —— 改动与部署说明

13 个文件修改 + 新增 `.dockerignore`。`superadmin/super123` 默认密码问题按你的要求忽略（单人使用）。

```
app.js                  启动时校验 SESSION_SECRET（缺失或 <32 字符直接拒绝启动，附生成命令）
docker-compose.yml      改用 env_file: .env 整体注入配置，删掉明文兜底密钥
.dockerignore           新增：构建镜像时排除 .env / data / node_modules / .git
.env.example            补全阿里云短信、SMTP、飞书全部变量说明
lib/smsGateway.js       短信配置缺失时给明确中文报错（缺哪个环境变量说清楚）
lib/schema.js           sales/return_order_items 新增 cost_price_snapshot 列 + 老数据自动回填
lib/rateLimiter.js      重写：每 key 记录自己的窗口 + 每 5 分钟定时清理，不再无限膨胀
lib/trialProvision.js   试用开通的 db 连接用完即关（修复句柄泄漏）
routes/platformAdmin.js 新建租户的 db 连接用完即关（修复句柄泄漏）
routes/dashboard.js     看板口径与经营报表统一：销售额/欠款都扣掉关联已审核退货
routes/report.js        毛利改用明细行成本快照，不再按商品当前成本现算
routes/sales.js         开单时写入成本快照
routes/returns.js       退货开单时写入成本快照
routes/products.js      删除检查补齐退货明细+出入库流水，提示文案与实际一致
```

## 这次修的核心问题

1. **试用注册在容器里必然失败**：之前 docker-compose 只注入 PORT/SESSION_SECRET，短信配置根本进不了容器。
2. **毛利会被追溯改写**：改商品成本价，历史上所有单据毛利跟着变 → 现在开单瞬间锁定成本。
3. **看板和报表对不上**：同一笔账首页和报表两个数 → 统一口径（都扣退货）。
4. **SESSION_SECRET 有公开默认值** → 现在没有就拒绝启动。

## 服务器部署步骤

```bash
# 1. 更新代码
cd ~/yayaerp && git pull

# 2. 创建 .env（必须！没有它容器会拒绝启动，日志会写明原因）
cp .env.example .env
openssl rand -hex 32          # 把输出填到 .env 的 SESSION_SECRET=
vim .env                      # 填好 SESSION_SECRET；HTTPS 配好后 COOKIE_SECURE=true

# 3. 填阿里云短信 4 个值（不填试用注册不可用，其他功能不受影响）
#    ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
#    ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE（模板需含 ${code} 和 ${min} 变量）
#
#    ⚠️ 进展（2026-09-06）：AK 与模板已配好（SMS_337380326，内容只有 ${code}）。
#    唯一缺口：账号下还没有短信签名（签名数 0），SendSms 报 isv.SMS_SIGNATURE_ILLEGAL。
#    需在 短信服务控制台 → 国内消息 → 签名管理 申请签名（如"鸭鸭进销存"）并等审核通过。

# 4. 重建并启动
docker compose up -d --build
docker logs jxc-app --tail 20  # 看到"进销存系统已启动"即成功
```

注意：`docker-compose.yml` 里 `environment.PORT=3000` 优先级高于 `.env` 里的 PORT，容器内固定 3000，不影响现有 Nginx 反代。本地开发用的 `.env`（PORT=3100）只在本地生效，别把本地这份直接当服务器配置用。

## 已验证（本地全链路测试，15 项全过）

- 全流程：建租户→登录→商品/供应商→采购→销售审核→退货审核→CSV 导出
- 成本快照：成本 10→99 改价后历史毛利仍是 30.00（旧代码会变 -148.00）；老库回填正确
- 看板口径：销 50/收 20/退 25 → 首页显示销售额 25.00、欠款 5.00，与报表一致
- 句柄泄漏：连建 2 个租户，进程打开的租户库句柄 1→1
- 启动校验：无/短 SESSION_SECRET 均 exit(1)；容器路径（无 .env 文件、纯环境变量）启动正常
- 短信链路：未配置时报 500 + 明确日志；重复发码被限流 429

## 待办

- [ ] 老胡：去 RAM 控制台给 AK 所属子账号添加 AliyunDysmsFullAccess（SendSms 实测 403）
- [ ] 老胡：提供模板 Code（SMS_ 开头，控制台→国内消息→模板管理；注意不是模板内容）
- [ ] 填齐后真实发一条验证码做端到端验证
- [ ] 服务器按上面步骤部署
- P2 项（CSV 文件名乱码、CSRF token、采购审核流、README 更新、分页等）本次未动，等你点头再做
