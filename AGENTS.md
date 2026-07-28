# 深圳交通探索器 · 项目记忆

这份文件是融合后的维护记忆。旧的根级脚本、独立 `metro/` 包、`static/` 复制品和
`zhanyue/` 中间应用均已退出架构，不得重新引入兼容入口。

## 沟通与完成标准

- 默认使用中文沟通。
- 功能工作必须落到实现、自动化验证和必要文档，不能只给建议。
- 公交与地铁是平行领域；公共能力必须优先放在 `common/`、`features/` 或共享 `web/`，
  不复制一套同功能实现。
- 用户明确要求远程交付的持续 goal，只有实现全部范围、完成必做验证与自查、提交并确认
  `git push` 成功后才可标记完成；额度或上下文续接不得降低完成标准，也不得以未推送状态
  冒充完成。

## 唯一架构

- Python 包：`src/transit_explorer/`。
- 统一命令：`transit-explorer doctor|build|publish|serve`，也可用
  `python -m transit_explorer`。
- 公交领域：`networks/bus/`；地铁领域：`networks/metro/`。两者保持
  `config/db/official/matcher/builder/service/router` 对称结构。
- 地铁展示几何必须经 `networks/metro/presentation.py` 合并
  `network.json.gz + layout.json`；Studio、Learn 和 Public publisher 共享该结果，不得各自
  实现布局覆盖。布局以逻辑线路键保存，正反向几何和联合 revision 由 Repository 生成。
- 内部制作版：`transit_explorer.editions.internal`；统一提供公交和地铁采集、浏览、学习与
  地铁示意工作台，默认只绑定 `127.0.0.1`。
- 公开只读版：`transit_explorer.editions.public`；只读取经过审计的 `dist/public/`，
  不读取数据库、完整线网、人工布局或内部页面。
- 共享前端位于 `web/`。Viewer、Collector、Learn 均通过当前路径选择
  `bus|metro` 适配器；不得再建立两份页面和运行时。

## 数据分层

- 可提交目录数据：`resources/bus/catalog.json`、`resources/metro/catalog*.json`。
- 本机可变数据：`var/{bus,metro}/network.db`、`network.json.gz`，
  `var/metro/layout.json`、`var/shared/language.json`。
- 构建产物：`dist/public/`。
- 不得提交 `.env`、`var/`、`dist/`、`data/`、`backup/`、数据库、完整精确线网、
  人工布局或任何密钥。

## API 与产品不变量

- 内部查询 API 统一为 `/api/{network}/network/*`、`/api/{network}/learn/*` 和
  `/api/{network}/search`。
- 公开 API 统一为 `/api/{network}/runtime|manifest|lines|search`；不得暴露内部构建、
  采集、编辑、OpenAPI 或 Studio 路由。
- 公开场景只能包含保护性栅格、量化锚点和审计允许的派生数据；不得恢复 `d`、`points`、
  精确 `x/y`、可逆 SVG 示意几何或源布局。公开服务健康信息必须保持
  `sourceGeometryMounted=false`。
- 练习输入的目标永远是车辆当前位置的下一站。
- 已行驶高亮必须严格结束在车辆位置；运动中的当前站间段不能提前标成完成，正向和反向都一样。
- `animated` 与 `real` 共用真实地图 renderer；切换地图模式不能重置线路、方向或练习状态。
- Metro 默认 Profile 为 `metroFinal`：同一 SVG 承载全网与单线，封面翻转不能修改数据坐标；
  线路拉伸必须烘焙真实坐标，并同步站点、标签、车辆和地区文字。
- 全线完成后保持当前线路选中，恢复原始线路与底图，镜头回弹到完整单线并停止自动跟随；
  手动拖动和缩放必须立即可用，不得自动返回全网。
- `standard`、`metroFinal`、`busExperimental` 是能力 Profile；旧值 `immersive` 只作为迁移别名，
  不得重新成为第四套实现。

## 必做验证

- 修改任何前端：`npm test`。
- 修改 Python、API 或构建：`python -m unittest discover -s tests -p 'test_*.py' -v`。
- 修改公开发布链：除上述测试外，至少运行一次
  `transit-explorer publish public`；发布必须以 `audit: passed` 结束。
- 提交前运行 `python -m transit_explorer doctor`、`git diff --check`，并确认
  `git status --ignored` 中没有敏感文件被强制跟踪。
