# 导航栏精简 + 页面合并 —— 改动说明

10 个文件，全部是完整文件直接覆盖，路由/后端逻辑一行没动。

```
views/partials/header.ejs   导航栏本体：品牌名、顺序、移除顶部到期时间
views/sales.ejs             加"销售/退货" tab
views/returns.ejs           加"销售/退货" tab
views/purchases.ejs         加"采购单/供应商" tab
views/suppliers.ejs         加"采购单/供应商" tab
views/report.ejs            加"经营报表/出入库流水" tab
views/stock_log.ejs         加"经营报表/出入库流水" tab
views/products.ejs          加"商品/仓库" tab（即"基础信息"入口）
views/warehouses.ejs        加"商品/仓库" tab
views/users.ejs             加服务到期时间显示
public/style.css            加 .tabbar 样式
```

## 现在的导航顺序

首页 → 销售退货（入口是 /sales）→ 库存 → 客户 → 调拨 → 采购（入口是
/purchases）→ 经营报表（入口是 /reports）→ 基础信息（入口是 /products）
→ 账号

点进"销售退货"能看到顶部有"销售 / 退货"两个 tab 按钮切换，其余三组
（采购/供应商、报表/流水、商品/仓库）同理。URL 还是原来那几个
（`/sales`、`/returns`、`/purchases`、`/suppliers`、`/reports`、
`/stock-log`、`/products`、`/warehouses`），只是从导航栏收起来了，
用 tab 的方式呈现，所以之前有没有收藏这些链接、有没有别的地方引用
这些 URL，都不受影响。

## 我怎么验证的

用 `ejs.compile()` 把这 10 个模板全部过了一遍语法检查，还完整渲染了
首页和账号页两个真实场景（假数据），确认：
- 品牌名正确显示"鸭鸭进销存"
- 导航项顺序跟你要的一致
- 顶部不再显示到期时间
- 账号页正确显示"服务到期时间：xxxx-xx-xx"

没能对着真实数据库跑一遍（原因跟之前一样，`better-sqlite3` 涉及原生
编译，这边环境跑不起来），部署后建议你手动点一遍这几个 tab 切换，
确认样式和跳转都正常，尤其留意手机端（导航栏在手机上是通过
`.nav-toggle` 那个汉堡菜单展开的，没改这部分逻辑，理论上不受影响，
但建议还是看一眼）。

## 部署

跟之前"密码重置"那次一样，只是页面模板改动，没加依赖：

```bash
git add views/ public/style.css
git commit -m "导航栏精简：品牌名改鸭鸭进销存，合并销售退货/采购供应商/报表流水/商品仓库"
git push

cd ~/yayaerp
docker-compose up -d --build
# 如果又遇到 ContainerConfig KeyError，先手动删旧容器再 up：
#   sudo docker rm -f $(sudo docker ps -a -q -f name=jxc)
#   docker-compose up -d
docker logs jxc-app --tail 20
```
