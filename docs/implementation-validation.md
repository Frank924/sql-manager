# SQL Manager 功能验证

## 验证覆盖

| 验证 | 结果 | 覆盖内容 |
| --- | --- | --- |
| 前端模型测试 | 10 项通过 | 累计版本差集、仅代码发布、安装与基线确认、失败阻断、降级保护 |
| Java 测试 | 10 项通过 | 工作区服务、HTTP API、部署地址访问与同源写入 |
| JAR 集成测试 | 15 组检查通过 | 服务器 IP 访问、SQL 原始字节、ZIP 执行顺序与校验值、结果登记、并发冲突、重启持久化和备份恢复 |
| Docker 验证 | 通过 | 从 JAR 构建镜像、提供前端页面、容器重建时保留台账和 SQL 原文件 |
| 浏览器操作 | 通过 | 上传脚本、发布版本、登记基线、生成升级包、逐文件登记和刷新后持久化 |

交付流程使用独立测试工作区验证。环境登记基线后，可以下载从当前 SQL 版本升级到目标版本所需的文件。逐文件登记成功后，环境台账更新 SQL 执行进度，代码版本继续独立维护。

![交付登记后的环境台账](../ui-prototype/design/implementation-verified.png)

## 运行验证

从项目根目录运行构建与测试。

```sh
./scripts/build.sh
npm --prefix ui-prototype test
python3 scripts/smoke_test.py
docker build -t sql-manager:1.0.0 target/deploy
python3 scripts/docker_smoke_test.py
```

构建脚本运行 Java 测试并生成交付 JAR。HTTP 集成测试使用临时数据目录，Docker 测试使用独立容器和命名卷，并在结束后清理验收资源。

部署与备份说明见 [项目 README](../README.md)。
