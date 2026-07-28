# 深圳公交 & 地铁 · 高德数据采集、线网可视化、站名学习、示意几何

一个本地 FastAPI 工具链：从深圳市交通运输局官方线路表 + 高德 `AMap.LineSearch` 出发，
把**公交**和**地铁**两条管线统一整理到同一个固定坐标空间，再用 Canvas + LOD 高效可视化，
并提供**站名学习**（拼音 / 粤语 / 音频）和**地铁示意几何**（真实驱动八方向 + 共享换乘锚点）能力。

当前版本已经完成与 `Easy Cantonase` 的体验架构融合：公交与地铁共用“扁平示意 / 动画地图 /
真实地图”三模式、下一站输入状态机、车辆平滑进度和镜头跟随。站粤公开版改用保护性栅格与
站间动画图集，公开服务不再读取精确示意 JSON，也不再提供可重建线路的 `points` API。

完整边界、数据分级、公开构建和验证方式见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

> 地铁示意系统（生成器 + 校核工作台 + 站粤导出）由 GLM 贡献，详见 [`GLM/README.md`](GLM/README.md)。

---

## 项目能做什么（一张图）

```
官方线路表（交运局）            高德 AMap.LineSearch（浏览器批量）
        │                              │
        ▼                              ▼
   官方站序/线路号  ──自动匹配──▶  真实 GCJ-02 几何 + 站点坐标
        │                              │
        │   ┌────────── 公交管线 ──────────┐    ┌──── 地铁管线（metro/）────┐
        │   │ build_network.py             │    │ metro/build_network.py      │
        │   │ · 全局投影 · 三级 LOD         │    │ · 同样管线 · 16 条线        │
        │   │ · 站序对齐 · 站点聚合         │    │ · + 八方向示意 + 共享锚点    │
        │   ▼                              │    ▼                             │
        │   data/network.json.gz           │   data/metro_network.json.gz     │
        │                                  │   (+ schematic / transfer_anchors)│
        ▼                                  ▼                                  │
   /bus  Canvas 全网查看            /metro  Canvas 查看  +  /metro/studio 校核工作台
        │                                  │                                  │
        ▼                                  ▼                                  ▼
   /bus/learn  站名学习          /metro/learn  站名学习           metro/export_zhanyue.py
   (拼音/粤语/音频)               (拼音/粤语/音频)                → 站粤 v3 DATA.lines[]
```

**两条管线共用**：FastAPI 服务（`app.py`）、站名语言库（`language_data.py`，拼音 / 粤拼 / 音频 / 备注）、
高德采集与候选评分机制。区别只在：地铁额外做示意几何，并多一个校核工作台。

---

## 一、安装

要求：**Python 3.9 或更新**（本项目按 3.9 兼容修订过类型注解，3.10+ 亦可）。

### macOS / Linux

```bash
cd Shenzhen_Transit_Explorer
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Windows PowerShell

```powershell
cd Shenzhen_Transit_Explorer
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

---

## 二、配置高德 Key

在高德开放平台创建应用并添加 **Web端（JS API）Key**，编辑 `.env`：

```dotenv
AMAP_JS_KEY=你的Web端Key
AMAP_SECURITY_CODE=你的安全密钥
AMAP_CITY=深圳
COLLECT_DELAY_MS=1200
```

建议在高德控制台把域名白名单限制为本机开发地址（`127.0.0.1`、`localhost`）。
采集页会在浏览器里直接使用 Key 和安全密钥——**不要把带真实 `.env` 的采集程序部署到公开网站**；
公开部署应按高德文档改用代理安全密钥方式。

---

## 三、启动与页面总览

```bash
python app.py        # 或 ./run.sh  /  Windows: run.bat
```

打开 `http://127.0.0.1:8000`，主要页面：

| 页面 | 地址 | 说明 |
|---|---|---|
| 公交全网查看 | `/bus` | Canvas + LOD + 视口裁剪的全市线路叠放 |
| 公交采集 / 复核 | `/bus/collector` | 高德批量采集、候选评分、人工指定上下行 |
| 公交站名学习 | `/bus/learn` | 单条线路示意 + 拼音 / 粤语 / 音频练习 |
| 地铁全网查看 | `/metro` | 同样的 Canvas 渲染器，16 条线 |
| 地铁采集 / 复核 | `/metro/collector` | 地铁高德候选采集与复核 |
| 地铁站名学习 | `/metro/learn` | 单条线路示意 + 站名练习 |
| **地铁示意校核工作台** | `/metro/studio` | 拖换乘锚点联动、调骨架/站距、冻结导出（GLM 贡献） |

> 兼容旧入口：`/` → `/bus`；`/collector`、`/learn`、`/schematic` 为历史跳转。

---

## 四、公交：批量采集高德数据

进入 `/bus/collector`，浏览器逐条调用 `AMap.LineSearch(route_no)`，每个线路号只查一次，
再把高德返回的多个候选分别匹配到官方上行/下行（不会把线路机械乘以两个方向重复查询）。
结果即时写入 `data/bus.db`，支持暂停/继续、关闭后重开、失败项重试、保留全部候选、低置信度人工指定。

自动匹配权重：`45% 起终点 + 40% 官方站序与高德站点匹配 + 15% 线路号`。

**建议节奏**：先把"本轮最多线路"设 `20`、间隔 `1200ms` 试跑，确认 Key/配额/匹配正常后，
再分批 `100 + 100 + ...`。采集期间保持标签页打开；每条完成即落库，刷新或意外关闭不丢已完成结果。

项目已内置交运局 **2026 年 6 月**公示数据：`data/official_routes.json`（869 条线路、1470 个上下行方向）、
原始附件 `data/source.xlsx`。

---

## 五、公交：构建全网

采集到一定数量后，点采集页的"构建全网"，或终端：

```bash
python build_network.py                   # 纳入所有已确认线路
python build_network.py --matched-only    # 只纳入完全确认的
```

`build_network.py` 会：① 全部高德 GCJ-02 坐标统一投影；② 一次全局边界变换固定相对位置；
③ 每条方向线路三级简化路径（总览/普通/详细）；④ 官方站序与高德站点顺序匹配；
⑤ 未匹配到坐标的站点沿线插值并标记"近似"；⑥ 聚合同名且相距很近的重复站点；
⑦ 输出 `data/network.json.gz`。

不必等 869 条全采完——先采 20 条做端到端验证，再边采边重建。

---

## 六、公交：全网查看界面

`/bus` 使用 Canvas 双图层 + 三级 LOD + 视口裁剪，避免为 ~1500 条方向线路、数万站点创建海量 DOM：

- 全市总览只绘制约 1500 条简化 Canvas 路径；
- 中等缩放显示视口内中级折线；
- 详细缩放显示视口内详细折线与站点；
- 选中线路懒加载完整站序与详细路径；
- 多线共用站点只绘一次；区分高德直接匹配站点与插值"近似"站点；
- 支持拖动/缩放、点击线路、搜索线路号/起终点/企业/站名、全线路高亮。

---

## 七、地铁管线（`metro/`）

地铁与公交同构，独立子包 `metro/`：

- **官方站序**：`metro/official_sync.py` 抓取交运局地铁线路页，解析"沿途站点：A—B—C"，
  产出 `data/metro_official.json`（含 id/名称/颜色/别名/站序）。无需网络也有种子 `data/metro_official_seed.json`。
- **采集 / 复核**：`/metro/collector` 调高德 `AMap.LineSearch`，`metro/matcher.py` 用
  `序序 0.75 + 起终点 0.15 + 线名 0.10` 评分并尝试正反向定向，结果入 `data/metro.db`。
- **构建**：

  ```bash
  python -m metro.build_network
  #   可选：--schematic-alpha 0.6  --schematic-bend 120  --no-schematic
  ```

  产出 `data/metro_network.json.gz`（每条线 forward+reverse，含真实几何 `paths.detail` + `stops[].progress`）。
- **查看**：`/metro` 用同一套 Canvas 渲染器。

---

## 八、地铁示意几何系统（真实 → 八方向 + 共享锚点）

> 完整设计、算法、验证见 **[`GLM/README.md`](GLM/README.md)**。这里只给速览。

以真实高德几何为源，生成横竖 / 45° 八方向示意；**换乘锚点全网共享同一坐标、骨架强制穿过它**
（构造性共点，不再事后 snap）。站距用 α 混合：`α·真实 + (1−α)·均匀`。

- 生成器：`metro/schematic.py`（端口自 `static/learn/geometry.js`，与 JS 逐点一致），
  随 `metro/build_network.py` 一并写入 `schematic` / `transfer_anchors` 字段。
- **校核工作台 `/metro/studio`**：拖换乘锚点 → 所有经过线路同步；拖折点 / 站点；α 滑杆；撤销/重做；
  实时过近站距诊断；保存（`data/metro_schematic_layout.json`）/ 导出。
- **冻结导出**：

  ```bash
  python -m metro.export_zhanyue     # → data/zhanyue_metro_data.json
  ```

  产出站粤 v3 `DATA.lines[]` 格式（`d` + `progress` + 站点字段），站粤侧零代码改动。

> 即便不重新构建 gz，`GET /api/metro/schematic` 也会在内存即时生成示意，工作台开箱即用。

### 站粤双构建（推荐）

当前项目已经把历史单文件整理为正式维护源码，并将内部校核版和公开学习版分开：

```bash
python -m metro.export_zhanyue
python -m zhanyue.build
```

输出：

```text
zhanyue/dist/review/index.html   # 内部完整校核版，含精确线路和导入/导出
zhanyue/dist/public/index.html   # 公开学习版，不内嵌完整线路
```

启动隔离后的公开学习服务：

```bash
python run_public.py
```

完整目录、环境变量、API、安全边界、部署与测试说明见
[`zhanyue/README.md`](zhanyue/README.md)。不要将根 `app.py` 或 review HTML 原样部署到公网。

公开学习版保留扁平示意、动画地图、真实地图、单线浏览、站点搜索、正反向、站点定位、全线
播报、30 秒挑战、全线拼音、全拼/首字母输入以及计时、正确率和速度统计；只排除校核编辑、
导入导出和精确示意资产。公开进程只读取预构建栅格、动画图集和派生 GCJ-02 数据。

### 旧单文件注入方式（仅兼容）

旧流程仍可执行：

```
python data/apply/apply_zhanyue_json.py \
  --json data/zhanyue_metro_data.json \
  --html data/apply/index.html \
  --in-place \
  --version-storage-key
```

例如：

```
python apply_zhanyue_json.py \
  --json metro/data/zhanyue_metro_data.json \
  --html zhanyue/index.html \
  --in-place \
  --version-storage-key
```

运行后：

```
zhanyue/index.html       # 已嵌入新 JSON
zhanyue/index.html.bak   # 原 HTML 备份
```

`--version-storage-key` 建议保留。它会把：

```
zhanyue-review-v3
```

改成类似：

```
zhanyue-review-v3-2026-07-27-a1b2c3d4e5
```

这样浏览器以前保存的校核数据不会覆盖本次嵌入的数据。

## 不覆盖原 HTML

想先生成一个新文件检查：

```
python apply_zhanyue_json.py \
  --json data/zhanyue_metro_data.json \
  --html index.html \
  --output index.new.html \
  --version-storage-key
```

也可以省略 `--output`，默认生成：

```
index.with-data.html
```

---

## 九、站名学习（`/bus/learn`、`/metro/learn`）

公交与地铁复用同一份 `static/learn.html + static/learn/` 产品界面：站点按线路顺序展示，配
拼音、粤拼和音频，并提供扁平示意、动画地图、真实地图、下一站输入练习和低置信度人工校核。
内部扁平模式由 `geometry.js` 生成八方向示意；两种真实地图模式共用 `real-map.js`，地图切换
不会重置当前站、输入或计时。
语言数据由 `language_data.py` 统一管理，存于 `data/station_language.json`，公交地铁共享。

---

## 十、人工复核

采集页右侧列出 `review / failed / no_data / error` 状态的线路，点击查看高德返回的全部候选，
分别给出总分、起终点分、站序分、候选站点数、路径点数，可手动 `设为上行 / 设为下行`
（地铁为正向 / 反向）。人工选择覆盖自动选择并落库。

---

## 十一、更新官方线路数据

公交（交运局公交线路 Excel）：

```bash
python sync_official.py                                  # 自动查找最新 Excel
python sync_official.py --xlsx /路径/深圳市公交线路一览表.xlsx   # 用自己下载的
```

地铁（交运局地铁线路页）：在 `/metro/collector` 点"同步官方"，或调用 `metro/official_sync.py`。

通过线路指纹判断变化：未变线路保留高德缓存；新增/变化线路重入 `pending`；已取消线路标为非活动。
随后只需重新采集新增或变化线路。

---

## 十二、文件结构

```text
Shenzhen_Transit_Explorer/
├── app.py                     FastAPI 服务（挂载公交路由 + metro 路由）
├── db.py                      公交 SQLite、评分、候选保存、人工选择
├── build_network.py           公交：全局投影、LOD、站序对齐、聚合
├── sync_official.py           公交：同步并解析官方 Excel
├── language_data.py           站名语言库（拼音/粤拼/音频/备注），公交地铁共享
├── requirements.txt  .env.example  run.sh  run.bat
│
├── metro/                     ── 地铁子包 ──
│   ├── router.py              地铁 FastAPI 路由（采集/构建/查看/学习/studio）
│   ├── build_network.py       地铁构建（真实几何 + 示意几何）
│   ├── schematic.py           ★ 八方向示意生成器 + 全网换乘锚点（GLM）
│   ├── export_zhanyue.py      ★ 冻结布局 → 站粤 DATA.lines[]（GLM）
│   ├── db.py  matcher.py  official_sync.py  constants.py
│
├── static/
│   ├── index.html / viewer.js / styles.css          公交 Canvas 全网查看
│   ├── collector.html / collector.js                公交采集与复核
│   ├── learn.html + learn/                          公交/地铁共享三地图学习界面
│   ├── metro_index.html / metro_viewer.js           地铁 Canvas 查看
│   ├── metro_collector.html / metro_collector.js    地铁采集与复核
│   ├── metro_studio.html / metro_studio.js / .css   ★ 示意校核工作台（GLM）
│   └── learn/core.js / geometry.js / real-map.js    状态、八方向与真实地图 renderer
│
├── data/
│   ├── official_routes.json / source.xlsx           公交官方线路（869 条）
│   ├── bus.db / network.json.gz                     公交库 / 全网（构建后生成）
│   ├── metro_official.json / metro_official_seed.json  地铁官方站序
│   ├── metro.db / metro_network.json.gz             地铁库 / 全网（+ schematic 字段）
│   ├── station_language.json                        站名语言覆盖
│   └── metro_schematic_layout.json                  工作台保存的校核结果（运行时）
│
├── GLM/                        ── GLM 贡献归档 ──
│   ├── README.md              示意系统详细文档（设计/算法/运行/验证/回退）
│   ├── CHANGES.patch          基线→功能完整可移植补丁
│   ├── FILES.txt              改动文件清单
│   └── assets/                工作台截图、全网示意、站粤导出预览
│
├── zhanyue/                    站粤内部精确版 + 公开衍生资产构建与隔离服务
├── tests/                      共享学习状态、地图与公交构建回归测试
└── ARCHITECTURE.md             融合边界、Geometry Provider 与公开安全设计
```

---

## 十三、和附件 HTML 的关系

附件 HTML（SVG 全量渲染）保留了：全局固定坐标、线路搜索与高亮、站点按线路顺序展示、
深色线网界面、低置信度人工校核。

没有沿用它的 SVG 全量渲染，因为公交站点数量大得多——核心渲染器换成 Canvas + LOD + 视口接口，
避免大量 `path/circle/text` DOM 节点卡顿。

> 关于"地铁示意图排版"：早期版本曾注明"需要在全量高德数据整理完成后增加示意图排版与
> 人工折点编辑阶段"。**该阶段现已由地铁示意几何系统完成**（见上文「八、地铁示意几何系统」
> 与 [`GLM/README.md`](GLM/README.md)）：真实几何 → 八方向示意 + 全网共享换乘锚点 + 校核工作台 + 站粤导出。

---

## 十四、常见问题

### 1. 高德地图 API 加载失败
检查：Key 类型是否为 Web端（JS API）；安全密钥是否正确；域名白名单是否含 `127.0.0.1`；
系统时间与网络是否正常。

### 2. 一些线路没有结果
可能：高德未收录；高德名称与官方线路号不一致；线路新开/临时/已调整；Key 配额或服务错误。
先"重试失败项"，仍无结果的需要人工补充或站点地理编码重建。

### 3. 为什么有黄色"近似"站点
官方表只有站序没有坐标。某个官方站名没和高德途经站点直接匹配时，构建器按前后已匹配站点在线路上插值，
该站仍被包含但标记为近似，不伪装成高精度。

### 4. Python 版本 / `str | None` 报错
本项目按 **Python 3.9** 兼容修订过类型注解（`Optional[str]`、`List[Dict[str, Any]]` 等），
无需额外装 `eval_type_backport`。先 `python --version` 确认 ≥ 3.9，依赖混乱时删 `.venv` 重建即可。

### 5. 地铁示意工作台打不开 / 显示空
确认服务已加载新代码（旧进程需重启 `python app.py`）；`/api/metro/schematic` 即便 gz 未烘焙示意
也会内存即时生成。详见 [`GLM/README.md`](GLM/README.md)。

---

## 数据与 API 来源

- 深圳市交通运输局 · 公交线路、站点一览表：
  `https://jtys.sz.gov.cn/zwgk/ztzl/ggqsydw/jt/gj/ywxx/gjlx/`
- 深圳市交通运输局 · 地铁线路与站点：
  `https://jtys.sz.gov.cn/jtzx/wycx/dtcx/dtxl/content/post_12601089.html`
- 高德地图 JavaScript API 2.0 公交线路查询：
  `https://lbs.amap.com/api/javascript-api-v2/guide/services/bus`
- 高德 JS API 安全密钥：
  `https://lbs.amap.com/api/jsapi-v2/guide/abc/prepare`
