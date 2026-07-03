# LEARNINGS — custom-travel (TREK 中国化 fork)

## 项目关键事实
- **上游**：mauriceboe/TREK（AGPL v3）。npm workspace（根目录 `npm ci`，**不要**在 client/server 子目录单独 `npm ci`，会破坏 hoisting 导致 typecheck 找不到模块）。
- **商标**：上游 TRADEMARKS.md 禁止 diverge fork 名字含 "TREK"，所以叫 custom-travel。README 可声明 "a fork of TREK"，不可用其 logo。
- **SSH 推送**：本机是多账号 SSH 路由，wsxwj123 账号必须用 `git@github.com-wsxwj123:...`（不是 github.com），否则 Permission denied。

## 架构决策（改动模式）
- **坐标系**：存储层全 WGS-84；高德数据入库前 GCJ→WGS（server/amapService）；渲染对齐用自定义 Leaflet CRS（client/src/components/Map/chinaCrs.ts 的 CRS_GCJ02，在投影层组合转换）——**不要**在业务代码里逐点转换。CRS 是 MapContainer 不可变 prop，换坐标系瓦片要用 key 强制 remount。
- **中国模式开关**：服务端 = `AMAP_API_KEY` / `QWEATHER_API_KEY` 环境变量；客户端 = 当前瓦片 URL 是否 autonavi/amap（`isChinaMapMode()`），不引额外 config 端点。
- **provider 分支模式**：新服务放独立文件（amapService/qweatherService），原文件只加薄 if 分支 + 失败回退原逻辑，尽量减小与上游的合并冲突面。
- **高德路径规划**：走服务端代理 `POST /api/maps/route`（key 不出服务器），无 key 返回 501，客户端记住后回退 OSRM。walking/bicycling 不支持途经点，按相邻两点串行逐段调用。
- **CSP**：国内 API 全在服务端调用、瓦片走 `img-src https:`，connect-src 无需加高德/和风 host。

## 环境坑
- 本机 Node 24 自带 `globalThis.localStorage`（无 getItem 方法）与 vitest jsdom 冲突 → client 部分 UI 测试（glProviders/MapView 等 8 个）**上游原样也挂**，非回归。CI 用 Node 22 正常。
- Docker 基线容器跑法：`docker run -e ENCRYPTION_KEY=... -e ADMIN_EMAIL/PASSWORD mauriceboe/trek`，健康检查 `/api/health`。
- 高德 API 错误 `INVALID_USER_KEY` = 请求已到达高德服务器，可用于无真实 key 时验证分支接通。

## 待办（Phase 2/3，未做）
- 12306 查询 MCP 工具（server/src/mcp/tools/ 新文件 + tools.ts 注册一行）
- OTA/打车深链按钮（ctrip:// qunarphone:// diditaxi:// dianping://，微信内会被限制）
- 飞猪 flyai / 滴滴 MCP / 高德官方 MCP 接入文档
- Dockerfile 国内源参数化（npm registry、KDE CDN 的 kitinerary 可选化）
- MapViewGL（Mapbox/MapLibre）不支持自定义 CRS，中国模式请用 Leaflet provider
- 登录页 MuseoModerno 品牌字体已移除（回退 sans-serif），要恢复可加 @fontsource/museomoderno

## 社媒导入功能（2026-07-03）
- 管线：`socialImportService.ts`（抓取+编排）→ `llmService.ts`（OpenAI 兼容抽取，DeepSeek 默认）→ `mapsService.searchPlaces`（复用现有 provider 分支做坐标匹配）→ `placeService.insertImportedPlaces`（复用 google/naver 导入的 dedup 语义）。
- 小红书走 xiaohongshu-mcp 的 **REST API**（`POST :18060/api/v1/feeds/detail`，feed_id+xsec_token 必填），不要碰它的 MCP 协议层（session/SSE 坑多且不稳定）。**已知抖动**：偶发 `not found in noteDetailMap` 错误，换一篇/重试即好；错误信息里引导用户粘贴文字兜底。
- B站：view API 免登录免 wbi；字幕走旧版 `/x/player/v2`（要 SESSDATA）；音频转写走 `yt-dlp -x`（不要自己实现 wbi——逆向文档仓库 bilibili-API-collect 已于 2026-01 被 B站律师函关停，playurl 强制 wbi 且 2026 新增 412 指纹风控专打海外机房 IP）。
- 端到端验证技巧：没有真实 LLM key 时，本地起 mock OpenAI 端点（固定返回 places JSON）+ 无 AMAP key 时自动落 Nominatim，可零成本全管线实测（实测橘子洲头坐标正确、dedup 和 unmatched 上报正常）。
