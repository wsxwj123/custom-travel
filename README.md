# custom-travel

自托管旅行计划器（中国本地化版）。本项目是 [TREK](https://github.com/mauriceboe/TREK) 的修改版（fork），面向中国大陆网络环境和旅游生态改造。

> This project is a fork of, and derived from, [TREK](https://github.com/mauriceboe/TREK) by Maurice Böttcher, licensed under AGPL-3.0. It is not affiliated with or endorsed by the upstream project. Per the upstream trademark policy, this fork uses a different name and does not use the TREK logo. Upstream README: [docs/README.upstream.md](docs/README.upstream.md).

## 与上游的差异（中国化改造）

| 模块 | 上游 | 本项目 |
|---|---|---|
| 地点搜索 / 逆地理 | Google Places / OSM Nominatim | **高德 Web 服务 API**（保留 OSM 回退） |
| 天气 | Open-Meteo | **和风天气 QWeather**（保留 Open-Meteo 回退） |
| 地图瓦片 | CartoDB / OSM / Mapbox | 预置 **高德瓦片**（GCJ-02），可配天地图 |
| 坐标系 | 全 WGS-84，无转换 | 存储 WGS-84，渲染/导入/导出边界做 **WGS-84 ↔ GCJ-02** 转换，杜绝国内底图偏移 |
| 路线导出 | Google Maps 链接 | **高德地图** 链接（uri.amap.com） |
| 前端 CDN | fonts.googleapis.com / unpkg | 本地自托管 |

规划中（Phase 2/3）：12306 余票查询 MCP 工具、携程/去哪儿/滴滴/大众点评深链跳转、飞猪 flyai · 滴滴 · 高德官方 MCP 接入指引、Docker 构建国内源。

## 快速开始

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32) docker run -d -p 3000:3000 \
  -e ENCRYPTION_KEY=$ENCRYPTION_KEY \
  -e DEFAULT_LANGUAGE=zh \
  -e AMAP_API_KEY=你的高德Key \
  -e QWEATHER_API_KEY=你的和风Key -e QWEATHER_API_HOST=你的专属Host \
  -v ./data:/app/data -v ./uploads:/app/uploads <image>
```

- 高德 Key：[lbs.amap.com](https://lbs.amap.com)（个人实名，Web 服务 API）
- 和风 Key：[dev.qweather.com](https://dev.qweather.com)（个人实名，注意使用你的专属 API Host）
- 备案说明：本机/内网自托管无需备案；部署到大陆服务器并绑定公网域名需办理非经营性 ICP 备案

其余部署方式（Docker Compose / Helm / 反向代理）与上游一致，见 [docs/README.upstream.md](docs/README.upstream.md)。

## License

AGPL-3.0（继承自上游，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)）。本仓库公开全部修改源码。
