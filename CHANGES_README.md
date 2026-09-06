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

# 3. 填阿里云短信认证服务配置（不填试用注册不可用，其他功能不受影响）
#    ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
#
#    ⚠️ 产品线（2026-09-06 定版）：本项目用「短信认证服务」（dypnsapi），
#    不是传统短信服务。签名/模板用阿里云赠送的，无需申请审核，
#    赠送值全账号通用（已实测发信+校验闭环通过）：
#      ALIYUN_SMS_SIGN_NAME=恒创联众
#      ALIYUN_SMS_TEMPLATE_CODE=100001
#      ALIYUN_SMS_TEMPLATE_PARAM={"code":"##code##","min":"5"}
#    （.env.example 里已带默认值，一般不用改）

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
- 短信链路：真实下发验证码到手机 + 校验闭环 PASS/拒绝 全通过（短信认证服务 dypnsapi）

## P2 批量修复（2026-09-06 晚，17 项回归全过）

```
utils/csv.js             CSV 文件名补 RFC6266 filename*=UTF-8''（中文文件名不再乱码）
app.js                   CSRF 同源校验（跨源 POST 拒 403，配合 SameSite=Lax 双层防护）；
                         全局错误处理器按 SQLITE_CONSTRAINT* 前缀匹配（CHECK 触发给友好提示而非 500）
middleware/rateLimit.js  登录限流改为只计失败次数（fail/reset 语义），成功登录清零，团队共用出口 IP 不再误拦
routes/auth.js           登录失败 fail() / 成功 reset()
routes/platformAdmin.js  同上（平台后台登录）
routes/sales.js          列表分页（每页 50，内存分页保证与"只看未结清"筛选组合正确）
views/sales.ejs          分页控件（上一页/下一页/页码）
routes/sales|returns|transfers.js + 三个表单   新增"存草稿"按钮（存为 draft，详情页继续编辑/提交审核）
lib/schema.js            inventory 表迁移加 CHECK(quantity>=0) 负库存数据库防线（老库负数自动归零）
lib/trialDb.js           清理废弃的本地验证码函数（短信认证服务接管后不再用）
routes/purchases.js      注明采购无审核流的设计决策（仅管理员可录，自审无意义）
README.md                重写为多租户现状（双入口登录/试用注册/部署/功能清单）
删除 views/platform_tenant_edit.ejs.txt（历史残留死文件）
```

回归测试 17 项全过：含跨源 403/同源放行、存草稿→提交→审核全链路、CSV 文件名头、分页参数健壮性、9 次失败后正确密码可登录（成功清零）、连错 10 次 429、老库迁移归零负数 + CHECK 拦截写入。

## 待办

- [x] 短信认证服务接入完成（2026-09-06 实测：真实下发验证码 + 校验闭环 PASS/拒绝 全通过）
- [x] 老胡：已确认手机收到验证码短信
- [x] P2 批量修复（见上）
- [ ] 老胡：禁用旧 AK（LTAI5t7t549eEHHEmfVE1N1S，无权限且已弃用）
- [ ] 服务器按上面步骤部署
