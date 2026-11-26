# SQL Manager 前端

此目录由已确认的方案 1 原型演进为正式前端，使用真实后端 API。完整运行方式、持久化和 Docker 说明见仓库根目录 README.md。

开发预览：`npm run dev -- --port 4173`，`/api` 代理至 `http://127.0.0.1:8080`。

`npm run build` 生成 `dist/client`，由后端 JAR 提供同源静态资源；`npm test` 检查前端状态与差集规则。

`design/` 与 `design-qa.md` 记录原型阶段视觉证据，不代表当前产品数据。正式运行从空工作区开始，无内置示例 SQL 或环境。
