# 项目维护约束

- 默认使用中文沟通；功能工作必须落到实现和验证。
- `app.py` 是内部制作服务；公网只能运行 `zhanyue.public_server`。
- 不得提交 `.env`、数据库、`data/*.gz`、精确站粤导出、人工 layout 或 `zhanyue/dist/`。
- 公共示意接口不得恢复 `d`、`points`、精确 `x/y` 或可逆 SVG 几何。
- 练习目标必须是下一站；已行驶进度必须严格结束在车辆位置，未来线路不得提前高亮。
- `animated` 与 `real` 共用真实地图 renderer；切换地图不能重置练习状态。
- 修改学习前端后运行 `npm test`；修改构建/公开服务后运行两个 Python unittest 套件和公开构建审计。
