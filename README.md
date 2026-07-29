# 深圳交通探索器

深圳公交与地铁的一体化工具链：采集和复核高德线路，构建固定坐标线网，浏览全网，
练习站名，并从可信源数据生成一个只含保护性派生资产的公开应用。

3.0 架构不再以根级脚本或独立应用拼接功能。公交和地铁是同一 Python 包里的平行领域，
Viewer、Collector、Learn 和公开运行时各只有一套实现。

## 架构

```text
resources/{bus,metro}          可版本化的官方目录
          │
          ▼
src/transit_explorer/networks/{bus,metro}
  config · db · official · matcher · builder · service · router
          │
          ├──────────────► var/{bus,metro}/network.db
          ├──────────────► var/{bus,metro}/network.json.gz
          │
          ├── editions/internal + web/ ──► 采集 / 浏览 / 学习 / Studio
          │
          └── features/publishing ───────► dist/public
                                                │
                                                ▼
                                      editions/public（只读派生服务）
```

地铁的展示几何只有一个可信合并入口：

```text
var/metro/network.json.gz + var/metro/layout.json
                         │
                         ▼
       networks/metro/presentation.py
          MetroPresentationRepository
              │          │          │
              ▼          ▼          ▼
            Studio     Metro Learn  Public publisher
```

`layout.json` 是人工复核覆盖层，不是另一份应用数据。Repository 同时处理旧版线路键迁移、
正向与反向几何、换乘锚点、联合 revision 和原子保存；Studio、内部练习与公开构建不得各自
再实现一套布局覆盖逻辑。Studio 保存请求必须携带加载时的 `baseRevision`；若其他页面已经
保存过新版本，服务端返回 `409 Conflict`，不会覆盖较新的布局。

核心目录：

```text
src/transit_explorer/
├── common/                 线网缓存、统一查询 API、站名语言库
├── networks/
│   ├── bus/                公交领域实现
│   └── metro/              地铁领域实现
├── features/               示意几何、公开派生资产和发布审计
├── editions/
│   ├── internal.py         内部制作版
│   └── public.py           公开只读版
├── cli.py
└── settings.py
web/
├── pages/                  共享内部页面
├── js/                     共享 Viewer / Collector / Learn / Studio
├── css/
└── public/                 公开应用源码
resources/                  可提交的官方目录
var/                        本机数据库和精确线网（忽略）
dist/public/                公开派生包（忽略）
tests/                      Python 与 Node 回归测试
```

## 环境

- Python 3.9 或更新版本
- Node.js 20 或更新版本（仅用于前端语法与回归测试）
- 高德 Web JS API Key（需要采集或真实地图时）

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
transit-explorer doctor
```

Windows PowerShell 激活命令为 `.venv\Scripts\Activate.ps1`；其余命令相同。

在 `.env` 中配置：

```dotenv
AMAP_JS_KEY=你的Web端Key
AMAP_SECURITY_CODE=你的安全密钥
AMAP_CITY=深圳
COLLECT_DELAY_MS=1200
```

`AMAP_SECURITY_CODE` 只用于本机内部制作版。公开真实地图应配置
`AMAP_SERVICE_HOST`，不要向公开浏览器返回安全密钥。

## 统一命令

```bash
# 检查 Python、目录数据、数据库、线网和公开包
transit-explorer doctor

# 构建精确线网
transit-explorer build bus
transit-explorer build metro
transit-explorer build all

# 公交可只纳入完全确认的方向；地铁可跳过示意生成
transit-explorer build bus --matched-only
transit-explorer build metro --no-schematic

# 将历史 Zhanyue v3 HTML 校验并暂存为正式分层数据（默认不覆盖 var）
transit-explorer import zhanyue /path/to/zhanyue.html

# 人工检查 report/layout/language/review 后再显式应用
transit-explorer import zhanyue /path/to/zhanyue.html --apply

# 内部制作版，默认 http://127.0.0.1:8000
transit-explorer serve internal

# 构建经过安全审计的公交+地铁公开包
transit-explorer publish public

# 公开只读版，默认 http://127.0.0.1:8010
transit-explorer serve public
```

没有安装控制台脚本时，所有命令都可写成
`python -m transit_explorer <command>`。

## 内部制作版

| 能力 | 公交 | 地铁 |
|---|---|---|
| 全网浏览 | `/bus` | `/metro` |
| 高德采集与复核 | `/bus/collector` | `/metro/collector` |
| 站名学习 | `/bus/learn` | `/metro/learn` |
| 示意布局工作台 | — | `/studio` |

共享查询合同：

```text
GET  /api/{network}/network/overview
GET  /api/{network}/network/view
GET  /api/{network}/network/routes/{route_id}
GET  /api/{network}/learn/routes/{route_id}
POST /api/{network}/learn/language
GET  /api/{network}/learn/language/export
GET  /api/{network}/learn/speech?text={station_name}
GET  /api/{network}/search
```

地铁制作链另外提供：

```text
GET  /api/metro/presentation
GET  /api/metro/presentation/revision
GET  /api/metro/studio
POST /api/metro/studio
```

Studio 的“保存并预览”会先校验并原子写入 `var/metro/layout.json`，返回新的联合 revision，
再打开带 revision 的 `/metro/learn`。已打开的练习页会收到布局更新提示；重新载入后首页、
单线练习和下一次 Public 构建读取完全相同的折点。保存采用乐观锁：页面加载的 revision
与服务器当前 revision 不一致时返回 409，保留浏览器里的草稿供人工处理。

Presentation API 直接给每个站返回 `stationKey` 与 `anchorKey`；Studio 不再复制 Python 的
站名归一化。浏览器即时预览的 α 站距与单调化集中在 `web/js/authoring/layout-math.js`，并与
Python 端共用同一组 JSON 数学夹具；最终保存仍由 Python 重新校验路径、progress、锚点和线路键。

历史单文件 HTML 只作为一次性迁移源。`import zhanyue` 会提取 `DATA`、解析 SVG path、把
逻辑线路与当前 forward route 按站序逐一校验、从 path + progress 重算站点/换乘位置，并对
同名站拼音、备注和音频 URL 的冲突出具报告。默认产物写入忽略的
`var/metro/imports/zhanyue-<hash>/`；只有 `--apply` 才会写入正式本机数据，且已有人工语言与
复核结果优先保留。HTML 本身不会进入运行时，也不得提交为第二数据源。

公交和地铁采集器各自负责目录策略、候选评分和选择字段；页面、运行控制、日志、
复核布局与构建动作共享同一个前端。

## 本机数据

`resources/` 只保存可复现的官方目录；所有采集状态和精确几何写入 `var/`：

```text
var/
├── bus/
│   ├── network.db
│   ├── network.json.gz
│   ├── manifest.json
│   ├── overview.json.gz
│   └── routes/
├── metro/
│   ├── network.db
│   ├── network.json.gz
│   └── layout.json
└── shared/
    ├── language.json
    └── review.json
```

从 2.x 本机目录升级时，可一次性复制已有数据后再运行 `doctor`：

```bash
mkdir -p var/bus var/metro
cp data/bus.db var/bus/network.db
cp data/network.json.gz var/bus/network.json.gz
cp data/metro.db var/metro/network.db
cp data/metro_network.json.gz var/metro/network.json.gz
cp data/metro_schematic_layout.json var/metro/layout.json
```

只复制实际存在且需要保留的文件。旧 `data/` 已被忽略，不再是运行时来源。

## 站名学习不变量

共享 Learn 运行时支持全网总览、单线示意、正反向、全线/30 秒练习、拼音与粤语信息、
扁平动画和真实地图。

- 当前站是车辆已到达的位置；练习先确认显示顺序中的起点，再逐站输入下一站。
- 起点确认题只推进输入进度，车辆保持原位；后续输入进度驱动车辆驶向下一站。
- 已行驶线路精确结束在车辆位置，未来段不会提前高亮。
- 切换扁平、动画或真实地图只更换 renderer，不重置练习状态。
- 粤语播报保持“本机音频 → 站点在线音频 → 系统粤语”的顺序。Chrome 等浏览器继续优先使用
  原有 Web Speech 粤语 voice；Safari 则优先通过 `/api/{network}/learn/speech` 明确调用已安装的
  `zh_HK`/Yue 声音并返回支持 Range 的 PCM/WAV。因此即使 Safari 未在 Web Speech 清单中暴露
  `Sin-ji`，也会播放系统粤语；所有后备都不会把任意普通话 `zh-*` voice 当成粤语。

内部状态使用明确的 `arrivedIndex`（车辆已到达）、`targetIndex`（物理行程下一站）和
`challengeIndex`（当前输入题）。`inputRatio` 与 `motionRatio` 分离，确保起点输入不产生位移。
每次渲染生成不可变 `JourneyFrame`，其中同时记录 `segmentStart`、`segmentEnd`、运动比例和
`phase`；路线、方向、浏览站、练习模式、地图模式、广播与 presentation revision 由 action
驱动的 `LearnStore` 持有。Renderer 只消费快照，不自行推断下一站；到站光波只接受应用层
显式提供的原始站点索引。

这些行为同时由内部 Learn 测试和公开运行时测试覆盖。

## 学习体验与镜头模式

公交和地铁共用一套 Learn 状态机、Practice Engine、Experience Controller、镜头控制器和
Renderer 合同。内部 Learn 的 Experience Profile 是产品能力包，不再作为普通用户开关：

| Profile | 说明 |
|---|---|
| `standard` | 标准线路聚焦、平滑车辆和三地图切换 |
| `metroFinal` | 地铁单 SVG 全网、封面翻转、真实坐标拉伸、镜头跟随和完成回弹 |
| `busExperimental` | 在公交 geometry 上试用拉伸、镜头跟随、到站脉冲和完成回弹 |

默认值为：

```text
Bus   = standard
Metro = metroFinal
```

内部学习页：

```text
http://127.0.0.1:8000/bus/learn
http://127.0.0.1:8000/metro/learn
```

扁平动画在当前 Profile 支持镜头跟随时，只向用户显示两种镜头偏好：

```text
全线视角
跟车镜头
```

切换镜头不会关闭 Metro Final 的封面翻转、真实坐标拉伸、到站反馈或完成回弹；切换到
动画地图、真实地图时镜头开关隐藏，线路、方向和练习进度保持不变。Metro 默认跟车镜头，
Bus 默认全线视角，清除或切换线路不会重置该偏好。

Profile 仍保留给运行时配置、兼容迁移和内部调试。URL 可为本次访问临时指定 Profile，且
优先于服务端默认值；旧版页面写入的 LocalStorage Profile 不再影响普通页面：

```text
http://127.0.0.1:8000/bus/learn?experience=busExperimental
http://127.0.0.1:8000/metro/learn?experience=standard
```

服务端默认值由 `.env` 控制：

```dotenv
TRANSIT_LEARN_EXPERIENCE_BUS=standard
TRANSIT_LEARN_EXPERIENCE_METRO=metroFinal
TRANSIT_LEARN_ALLOW_EXPERIENCE_OVERRIDE=true  # 是否显示可用的用户镜头偏好
```

只接受 `standard`、`metroFinal` 和 `busExperimental`；旧配置 `immersive` 会按网络迁移为
Metro `metroFinal` 或 Bus `busExperimental`，非法配置回退到 Bus `standard`、Metro
`metroFinal`。修改后重启 `python -m transit_explorer serve internal`。

Metro Final 使用同一个 SVG 表示翻转封面、完整人工线网和单线场景；选择线路时只翻显示层，
数据坐标不反写。当前线路通过烘焙坐标真实拉伸，站点、标签、车辆和地区文字使用相同中心与
比例，避免 Safari 的 SVG group 缩放消失问题。练习使用真实部分路径，正反向高亮都严格终止
在车辆中心；镜头具有死区、前方留白和渐进跟随，触控板手势会暂停自动接管。完成全线后
保持当前线路选中，线路与底图恢复原形，镜头轻微回弹到完整单线，自动跟随停止而手动导航
立即可用。

Mac 导航由共享 `NavigationController` 统一处理：普通双指滚动平移，`Shift + wheel` 横向
平移，Chromium `Ctrl + wheel` 以指针为中心缩放，Safari 使用
`gesturestart/change/end`；`deltaMode` 先标准化，连续输入每帧最多提交一次。手动导航暂停
镜头，只有下一次行程位置实际变化才恢复跟随。各 Renderer 不再分别注册一套手势。

键入热路径只更新输入反馈、车辆 transform 与已行驶 path；站点状态、标签和目标信标仅在到站、
标签选项或缩放比例变化时重建。几何缓存键包含 presentation revision、route、direction、
geometry mode 与 spacing mode，布局更新不会复用旧缓存。

练习可选择普通话全拼、粤拼、自然码/小鹤/微软/搜狗/智能 ABC/拼音加加/紫光双拼，并可打开
输入框内提示；这些设置保存在浏览器本机。无论输入方案如何，起点确认都保持车辆原位，之后
的目标始终是车辆当前位置的下一站。Bus 默认保持标准体验；启用 `busExperimental` 时复用
同一个 Controller，但仍使用公交 geometry、公交车和公交主题。超长公交线路会降低镜头强度，
练习正确性不受影响。

切换体验不会重置当前线路、方向、当前/下一站、已输入内容、计时、准确率、车辆位置或
地图模式；扁平动画、动画地图和真实地图仍共享同一份 JourneyFrame。

公开服务的 `/api/{network}/runtime` 返回相同 Profile 合同，并明确标记
`protectedGeometry: true`。公开增强镜头只使用保护性栅格和量化锚点，不读取或恢复精确
`d`、`points`、`x/y` 或源布局。

## 内部项目导航

所有内部页面顶部固定显示同一组七项导航，顺序和地址如下：

| 名称 | 地址 |
|---|---|
| 公交全线 | `/bus` |
| 地铁全线 | `/metro` |
| 公交练习 | `/bus/learn` |
| 地铁练习 | `/metro/learn` |
| 公交收集 | `/bus/collector` |
| 地铁收集 | `/metro/collector` |
| 地铁微调工作站 | `/studio` |

窄屏下导航横向滚动，不会隐藏入口。Learn 的项目导航与练习模式、地图样式、体验 Profile
分层显示。

## 公开发布与安全边界

`transit-explorer publish public` 在可信构建机直接读取 `var/` 中的精确线网和可选人工布局，
在临时目录生成派生包并执行审计，最后替换 `dist/public/`。公开服务只挂载这个目录。

公开包按网络采用不同成本策略：

- 公交：单层保护性线路栅格 + 量化站点锚点运动，适合大量方向线路。
- 地铁：多分辨率保护性栅格 + 站间动画图集，保留更细腻的学习动画。
- 真实地图：独立的 5 位小数派生地理折线，不复用内部完整精度对象。

审计会拒绝内部校核文件、源数据注入，以及场景中的 `d`、`points`、`bbox`、
精确 `x/y` 等可逆几何字段。公开服务关闭 OpenAPI/Docs，不包含采集、构建、编辑或
Studio API，`/health` 明确报告 `sourceGeometryMounted: false`。

可选公开配置：

```dotenv
TRANSIT_PUBLIC_ACCESS_TOKEN=
TRANSIT_PUBLIC_HOST=127.0.0.1
TRANSIT_PUBLIC_PORT=8010
TRANSIT_PUBLIC_LINES_PER_MINUTE=30
TRANSIT_TRUST_PROXY=false
AMAP_SERVICE_HOST=/_AMapService
```

只有反向代理可信地覆盖 `X-Forwarded-For` 时才启用 `TRANSIT_TRUST_PROXY`。

## 验证

```bash
npm test
python -m unittest discover -s tests -p 'test_*.py' -v
python -m transit_explorer doctor
git diff --check
```

Python 测试覆盖构建几何、地铁展示合并与 Studio→Learn 闭环、公交/地铁 API 对称性、
Zhanyue 导入冲突、revision 乐观锁、公开双网络发布、构建指纹、派生资产审计和公开服务隔离；
Node 测试覆盖显式 Journey 状态、Mac/Safari 导航、真实坐标拉伸、完成回弹、双拼/粤拼目标、
正反向精确进度、真实地图插值、焦点恢复以及公开下一站练习。

CI 在 Node 20、Python 3.9 和 Python 3.12 上执行同一套检查。
