# SQL Manager 前端

本目录包含 SQL Manager 的 React 和 Vite 前端。功能概览、运行方式和 Docker 部署见 [项目 README](../README.md)。

## 本地开发

启动后端后，从本目录启动 Vite。

```sh
npm ci
npm run dev -- --port 4173
```

Vite 将 `/api` 请求代理到 `http://127.0.0.1:18080`。`npm run build` 将静态文件输出到 `dist/client/`，供后端打包到 JAR。`npm test` 验证前端状态与版本差集规则。

相关文档包括 [API 约定](../docs/api-contract.md) 和 [界面与交互验证](design-qa.md)。
