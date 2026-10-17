# mixtunnel

单文件 Cloudflare Worker 代理。`_worker.js` 是**唯一真源**（可读版），`dist/_worker.js` 是构建期去指纹后的产物。

支持 VLESS / Trojan / Shadowsocks 三种应用层协议，入站覆盖 WebSocket、gRPC、XHTTP（叉HTTP）三种传输，出站支持直连与SOCKS5 / HTTP / HTTPS / TURN / SSTP / proxyIP 反代，并附带订阅生成与管理后台。

> 上游致谢：功能主体来自 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)，规则集来自 [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)。本仓库主要维护**去指纹构建管线**与部署配置。

---

## 快速开始

```bash
npm install                # 依赖只有 acorn（解析器）与 wrangler
npx wrangler login         # 首次需要登录 Cloudflare
npm run deploy             # = build + check + wrangler deploy
```

`deploy` 会先跑一遍构建自检（`tools/check.mjs`），任何一项不过就不会上传。

本地调试：

```bash
npm run dev                # build + wrangler dev
npm run tail               # 线上实时日志
```

### 必配变量

变量**不要写进 `wrangler.jsonc`**，在 Dashboard 的 Worker → Settings → Variables 里配置（或本地放 `.dev.vars`，已 gitignore）。

| 变量 | 说明 |
| --- | --- |
| `ADMIN` | 管理密码，也是代理开关。留空则整个代理功能关闭，访问返回 `/noADMIN` |
| `UUID` | 用户 ID。留空时由 `MD5(ADMIN + KEY)` 派生；建议显式指定 |
| `KEY` | 加密秘钥。用于登录 Cookie 与「快速订阅」路径，留空会用内置默认串 |
| `KV` | KV 命名空间绑定。**不绑则订阅与后台不可用**（返回 `/noKV`），只有代理能用 |

最小可用配置：`ADMIN` + `UUID` + `KV`。
绑定 KV 需要先取消 `wrangler.jsonc` 里 `kv_namespaces` 的注释并填入真实 namespace id。

### 全部环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN` / `admin` / `PASSWORD` / `password` / `pswd` / `TOKEN` / `KEY` / `UUID` / `uuid` | — | 管理员密码回退链，**任一命中即可** |
| `UUID` / `uuid` | 派生 | 须匹配 UUID v4 正则；未设置且无 KV 时触发 `/noKV` |
| `KEY` | 内置默认串 | 登录 Cookie = `MD5(UA + KEY + 密码)`，`Max-Age=86400`、`HttpOnly; Secure; SameSite=Lax` |
| `KV` | — | 存 `config.json` / `cf.json` / `tg.json` / `ADD.txt` / `log.json` |
| `HOST` | 当前域名 | 逗号或换行分隔的域名池，订阅里随机替换 `example.com` |
| `PATH` | — | 订阅节点路径前缀 |
| `PROXYIP` | 默认反代域名 | 反代地址，多值随机取一；设置后关闭默认反代兜底 |
| `GO2SOCKS5` | — | 追加进 SOCKS5 白名单的域名 |
| `TCP_CONCURRENT_DIAL` | `2` | 直连并发拨号路数；移动网未显式设置时强制为 `1` |
| `PROXY_CONCURRENT_DIAL` | `1` | 反代并发拨号路数 |
| `PRELOAD_RACE_DIAL` | 关 | 开启 DoH 预解析 + 竞速拨号 |
| `DEBUG` | 关 | `'1'` / `'true'` 打开调试日志 |
| `OFF_LOG` | 关 | `'1'` / `'true'` 关闭 KV 日志写入 |
| `BEST_SUB` | 关 | 允许本Worker 被上游当作「优选订阅生成器」抓取 |
| `URL` | `nginx` | 伪装页地址；`nginx` = 内置欢迎页，`1101` = 内置 CF 1101 页 |

---

## 路由

| 路由 | 用途 |
| --- | --- |
| `/version?uuid=` | 版本接口 |
| `/<KEY>` | 快速订阅，302到 `/sub?token=…` |
| `/sub?token=…` | 订阅（见下） |
| `/login`、`/logout` | 登录页 / 登出 |
| `/admin`、`/admin/*` | 管理后台（Cookie 鉴权，未登录 302 `/login`） |
| `/locations` | 反代 `speed.cloudflare.com/locations`（CM 优选 IP 表） |
| `/robots.txt` | `Disallow: /` |
| 任意其他路径 | 反代伪装页 |

后台子接口：`admin/log.json`（KV 日志）、`admin/getCloudflareUsage`（CF 用量）、`admin/getADDAPI`（优选 API 验证）、`admin/check`（SOCKS5/HTTP/HTTPS/TURN/SSTP 连通性检查）、`admin/init`（重置配置）、`GET|POST admin/config.json`、`admin/cf.json`、`admin/tg.json`、`ADD.txt`。

### 订阅

鉴权 token = `MD5(host + userID)`；另有给订阅转换后端用的按日轮换 token。

输出格式按优先级判定：`mixed` → `target=<subconverter target>` → `clash` → `singbox` → `surge&ver=4` → `quanx` → `loon`。
除上述六种外的客户端（如 v2rayN）走 `?target=` 交给外部 subconverter 转换。

常用参数：`token`、`target`、`emoji`、`udp`、`xudp`、`tls13`、`append_type`、`sort`、`cnIspCode`、`ed`（0-RTT）、`sub`（指定优选订阅生成器）。

---

## 目录结构

```
_worker.js        源文件（可读版，唯一真源）
wrangler.jsonc    部署配置（main = dist/_worker.js）
dist/             构建产物，不入库、不手工编辑
tools/            去指纹构建管线 —— 详见 tools/README.md
```

改代码只改 `_worker.js`；换字典值、决定哪些字段连键名一起改，一律改 `tools/rules.mjs`。

## 构建管线

```bash
npm run build      # _worker.js -> dist/_worker.js，并打印统计与特征对比
npm run check      # 漂移检测 + 结构等价证明 + 不变量 + 特征扫描
npm run verify     # build + check
```

产物相对源文件做了标识符改名、内部字段改名、明文拆分、剥注释、空白收敛——**值不变、语义等价**，其中「改字面量值」的部分是声明式、需人工确认的例外。实测体积 5.0 MB → 196 KB，Trojan 关键词、中文协议名、原始标识符指纹、注释残留均降到 0。

自检会证明「产物 = 源文件按规则表做的那几类变换，且没有别的差异」；它**不能替代运行时验证**，上线前请至少在 `npm run dev` 下点一遍登录 / 订阅 / WS 连接。

完整规则表与等价性证明的边界，见 [`tools/README.md`](tools/README.md)。

## 贡献者须知

1. **只改 `_worker.js`**，改完至少跑一次 `npm run verify`。`check` 发现产物与重新构建结果不一致会直接判失败——这是「不许手改 `dist/`」的强制点。
   - `npm run verify` 之外还有 `npm test`（Node 内置测试运行器，无需额外依赖）；`npm run deploy` 现在会自动带上测试。
   - `tests/` 里的单测通过复制 `_worker.js` 追加 `export` 的方式加载内部函数，**不改动生产文件**；新增纯函数时记得在 `tests/helpers.mjs` 的导出清单里补名。
2. **`_worker.js` 有 5 MB，但只有前约 6600 行是代码**，其余是一整块希伯来圣经填充注释（无功能，仅涨体积）。定位问题请在前 6600 行内搜索。
3. **注意文件编码**：`_worker.js` 带 UTF-8 BOM，而产物要求无 BOM（BOM 会被 `check.mjs` 判为不变量失败）。
4. `env.PROXYIP` / `env.UUID` / `env.ADMIN` / `/sub` / `token` 等名字是**对外契约**，与 Dashboard 变量名、客户端订阅参数绑定，不可改名。

## License

[ISC](package.json)