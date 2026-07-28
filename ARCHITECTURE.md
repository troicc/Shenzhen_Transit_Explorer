# Shenzhen Transit Explorer 融合架构

本仓库以原 `shenzhen_bus_and_metro_route` 为唯一数据与制作底座，并迁入
`Easy Cantonase` 已验证的三地图学习状态机、平滑车辆进度、真实地图镜头和输入焦点逻辑。

## 1. 运行边界

```text
官方数据 / 高德采集
        │
        ▼
公交与地铁构建器（受信制作区）
        │
        ├── GCJ-02 真实道路几何 ──► animated / real
        │
        └── 人工复核示意几何
                   │
             ┌─────┴────────────┐
             ▼                  ▼
       内部精确 review      公开衍生构建
       /metro/studio        栅格 + 锚点 + 图集
             │                  │
             ▼                  ▼
       internal FastAPI     public FastAPI
       可编辑/可导出          只读、无精确源数据
```

内部入口由根 `app.py` 提供；公开入口由 `zhanyue.public_server` 提供。公开进程只读取
`zhanyue/dist/public/`，不会读取精确导出、人工 layout、review HTML 或编辑工具。

## 2. 统一学习体验

`static/learn/` 是公交和地铁共用的学习前端：

- `app.js`：统一状态机与 `JourneyFrame`；
- `practice.js`：始终输入“下一站”，字符比例就是车辆从当前站到下一站的目标进度；
- `renderers.js`：内部扁平示意；
- `real-map.js`：`animated` 与 `real` 共用的高德 renderer，只切换样式、pitch 和镜头；
- `typing-focus.js`：练习输入焦点恢复；
- `api.js`：按 `/bus/learn` 或 `/metro/learn` 选择同构 API。

地图模式切换只替换 renderer，不会重建练习实例，因此线路、方向、当前站、输入内容、计时和
车辆插值进度都会保留。

## 3. Geometry Provider

内部学习 API 返回：

- 示意/焦点几何；
- GCJ-02 路径与站点；
- 语言、音频与校核字段。

公开学习 API 分成两个明确的数据面：

- `GET /api/lines/{id}/scene`：示意图栅格、多分辨率 URL、8 px 量化锚点、站间动画图集；
- `GET /api/lines/{id}/geographic`：5 位小数派生 GCJ-02 路径，仅用于高德真实地图。

公开 `scene` 永远不含 `d`、`points`、精确 `x/y` 或 `bbox`。真实地理路径与手绘示意路径在
模型、文件和接口上完全分离。

## 4. 公开资产构建

`python -m zhanyue.build` 在受信机器上生成：

```text
zhanyue/dist/
├── review/index.html                 精确内部校核版
└── public/
    ├── index.html                    统一公开学习 UI
    ├── manifest.json                 无几何线路目录
    ├── search-index.json             无几何站名索引
    ├── lines/{id}/scene.json         保护性示意场景
    ├── lines/{id}/geographic.json    派生真实地图数据
    └── assets/routes/{id}/
        ├── base@1x.webp
        ├── base@2x.webp
        ├── base@4x.webp
        ├── segment-NN.webp
        ├── segment-NN-forward.webp
        └── segment-NN-reverse.webp
```

每一站间区间拥有正向和反向 9 帧图集。浏览器按输入比例选帧，获得车辆与进度动画，但不会
拿到可重建线路的矢量折点。构建完成后 `audit_public_bundle()` 会拒绝包含内部数据、review
目录或精确示意字段的公开包。

## 5. 数据分级

- A 级：人工示意路径、精确站位、共享换乘锚点、layout、校核记录。只在制作区和内部版存在。
- B 级：高德 GCJ-02 道路几何。按线路输出派生、量化版本，用于真实地图。
- C 级：站名、线路名、站序、拼音、粤拼、换乘关系和颜色。可以公开。

## 6. 验证

```bash
npm test
python -m unittest discover -s tests -p 'test_*.py' -v
python -m unittest discover -s zhanyue/tests -v
python -m zhanyue.build
```

测试覆盖正反向进度末端、下一站输入语义、镜头跨角度边界、公交分片构建、公开包审计、旧
`/api/line/{id}` 删除、公开服务不挂载精确源数据，以及内部管理路由不出现在公开应用中。
