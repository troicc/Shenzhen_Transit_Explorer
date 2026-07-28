# 站粤双构建：内部精确版与公开衍生版

站粤使用同一份产品功能与学习状态，但把示意几何提供方式划分为两个安全域：

```text
精确站粤导出
├── review：精确矢量 + 校核/导入/导出，只供本机或内网
└── public：栅格示意 + 量化锚点 + 动画图集，只读公网服务
```

公开版拥有扁平示意、动画地图、真实地图、搜索、正反向、逐站浏览、全线播报、30 秒挑战与
全线拼音练习。它删除的是精确资产和管理权限，不是产品体验。

## 构建

```bash
python -m metro.build_network
python -m metro.export_zhanyue
python -m zhanyue.build
```

也可以只构建一个版本：

```bash
python -m zhanyue.build --mode review
python -m zhanyue.build --mode public
```

公开构建默认同时读取 `data/metro_network.json.gz` 中的 GCJ-02 地理路径。这份数据只在受信
构建机上读取，并被转成按线路分离、5 位小数量化的派生地理数据：

```bash
python -m zhanyue.build \
  --data /path/to/zhanyue_metro_data.json \
  --geographic-data /path/to/metro_network.json.gz \
  --dist /path/to/output
```

## 输出

```text
zhanyue/dist/
├── build.json
├── review/index.html
└── public/
    ├── index.html
    ├── manifest.json
    ├── search-index.json
    ├── lines/{id}/scene.json
    ├── lines/{id}/geographic.json
    └── assets/
```

`scene.json` 只包含多分辨率 WebP、站间正反向动画图集、站序/语言和 8 px 网格量化锚点。
它不含 `d`、`points`、精确 `x/y`、精确 `bbox`、折点或 layout。

公开构建结束时会自动执行部署包审计；如果出现精确源文件、review 目录、内部校核入口或
禁止几何字段，构建会失败。

## 启动

内部完整校核版：

```bash
python run_review.py
# http://127.0.0.1:8011
```

公开衍生版：

```bash
python run_public.py
# http://127.0.0.1:8010
```

不要把根 `app.py`、`dist/review`、精确导出或人工 layout 部署到公网。

## 公开 API

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/runtime` | edition、能力开关和浏览器安全的高德配置 |
| GET | `/api/manifest` | 无几何线路目录 |
| GET | `/api/search?q=罗湖` | 无几何站名搜索 |
| GET | `/api/lines/{id}/scene` | 栅格示意场景与量化锚点 |
| GET | `/api/lines/{id}/geographic` | 独立的派生 GCJ-02 路径 |
| GET | `/assets/...` | 不可变栅格资源 |
| GET | `/health` | 构建和安全边界状态 |

旧 `/api/line/{id}` 已删除，因为它返回的量化 `points` 仍可直接重建 SVG。

公开应用没有 `/docs`、`/openapi.json`、studio、collector、保存、导入、导出或语言修改接口。

## 配置

```dotenv
ZHANYUE_PUBLIC_ACCESS_TOKEN=
ZHANYUE_PUBLIC_HOST=127.0.0.1
ZHANYUE_PUBLIC_PORT=8010
ZHANYUE_PUBLIC_LINES_PER_MINUTE=30
ZHANYUE_TRUST_PROXY=false
ZHANYUE_PUBLIC_BUNDLE_PATH=/absolute/path/to/zhanyue/dist/public

AMAP_JS_KEY=浏览器可见的Web端Key
AMAP_SERVICE_HOST=/_AMapService
```

公网只提供 Web JS Key。高德安全密钥应由代理服务使用，不应写入公开 API 或页面。

## 测试

```bash
python -m unittest discover -s zhanyue/tests -v
```

测试使用仓库内的小型合成夹具，不依赖被忽略的精确生产数据，覆盖：

- review 与 public 使用不同 Geometry Provider；
- 公开 scene 只有栅格、图集和量化锚点；
- 公开部署包不含精确数据、layout 或 review；
- 真实地理数据与手绘示意场景隔离；
- 公开进程只挂载衍生目录；
- 旧可重建几何 API 与内部管理路由不存在。

## 安全边界

本结构阻止从 HTML/API 一键取得可编辑的手绘 SVG，但不能阻止截图、保存栅格或计算机视觉
重绘。可见署名、访问控制、限速和日志属于追踪/运营措施；真正的资产边界是“精确几何从不
进入公开部署包，也不被公开进程读取”。
