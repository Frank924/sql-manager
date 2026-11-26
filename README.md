# SQL Manager

独立运行的 SQL 文件与交付台账工具。上传原生 SQL，维护有序发布版本，根据各环境的人工登记结果生成缺失脚本交付包。工具不连接业务数据库，不执行 SQL。

界面沿用已确认的方案 1。第一版为单人本地工作区，管理一个逻辑业务库 `business`；每个环境单独填写实际数据库名。

## 本地运行

需要 Java 17+、Node.js 22+。项目包含 Maven Wrapper，不要求另装 Maven；首次构建需要下载依赖。

```sh
./scripts/build.sh
./scripts/start.sh
```

打开 **http://127.0.0.1:18080/**。前端已打包到 JAR，运行时只需要 Java。默认数据目录为项目根目录 `data/`，首次启动为空工作区。

更新应用时先停止正在运行的服务，再构建并重新启动；不要覆盖运行中的 JAR。重新构建不会清空数据目录。

```sh
DATA_DIR=/absolute/path/sql-manager-data SERVER_PORT=18081 ./scripts/start.sh
```

开发时可分别运行后端与 Vite：

```sh
./mvnw -f backend/pom.xml spring-boot:run
npm --prefix ui-prototype run dev -- --port 4173
```

开发启动后端时建议显式指定 `DATA_DIR`，避免 Maven 工作目录变化导致使用另一个数据目录。Vite 将 `/api` 代理到本机 18080。

## IntelliJ IDEA 运行与调试

本项目默认使用 **18080**，避免占用其他本地服务常用的 8080。IDEA、命令行、Docker 和前端开发代理使用同一默认后端端口。

1. 在 IDEA 中打开项目根目录 `sql-manager/`，不要只打开 `backend/`。在 **File → Project Structure → Project** 中选择 JDK 17。
2. 右键 `backend/pom.xml`，选择 **Add as Maven Project**，等待依赖导入。若已经导入，点击 Maven 窗口中的刷新按钮。

   让 Maven 自动设置源码目录，不要把整个 `backend/src` 标为 Sources Root。业务源码为 `src/main/java`，测试源码为 `src/test/java`。如果之前手工标记过目录，在 Project Structure → Modules 中移除重复的手工内容根目录，保留 Maven 的 `backend` 模块配置。

3. 第一次运行或修改前端后，在 IDEA Terminal 的项目根目录执行：

   ```sh
   npm --prefix ui-prototype ci
   npm --prefix ui-prototype run build
   ```

4. 在右上角选择已提供的 **SQL Manager** 运行配置，点击 **Run** 或 **Debug**。访问 **http://127.0.0.1:18080/**。

共享配置保存在 `.run/SQL Manager.run.xml`，使用普通 Java **Application** 类型，无需 Spring 专用运行配置。配置内容如下，若 IDEA 未自动加载，可据此手工创建：

| 配置项 | 值 |
| --- | --- |
| Main class | `com.sqlmanager.SqlManagerApplication` |
| Use classpath of module | `sql-manager`（Maven 后端模块） |
| JRE | Project SDK，JDK 17 |
| Working directory | `$PROJECT_DIR$`（项目根目录） |
| Environment variables | `DATA_DIR=$PROJECT_DIR$/data;SERVER_ADDRESS=127.0.0.1;SERVER_PORT=18080` |
| Program arguments | `--spring.web.resources.static-locations=file:./ui-prototype/dist/client/,classpath:/static/` |
| Before launch | Build |

该配置从前端构建目录直接提供页面，Java 后端可正常打断点，不需要先打包 JAR。数据继续使用根目录的 `data/`。切换到 IDEA 前先停止脚本或 Docker 启动的同端口实例；同一个数据目录也只能有一个运行实例。页面出现 404 时，检查第 3 步是否已生成 `ui-prototype/dist/client/index.html`。

同时开发前端时，在 IDEA Terminal 执行 `npm --prefix ui-prototype run dev -- --port 4173`，访问 `http://127.0.0.1:4173/`；IDEA 继续在 18080 运行后端。前端开发服务器会将 API 请求代理到后端。

配置项说明参见 [JetBrains Application 运行配置文档](https://www.jetbrains.com/help/idea/run-debug-configuration-java-application.html)。

## Docker 部署

在构建机上选择 JDK 17 和 Node.js 22+，在项目根目录打包：

```sh
java -version
./scripts/build.sh
```

`target/deploy/` 中的 `sql-manager.jar` 已包含前端页面和后端。把它和同目录的 `Dockerfile` 一起交付到服务器。镜像沿用 220 上 `xt-*` 服务的 `bellsoft/liberica-openjdk-rocky:17.0.16-cds`，内置 Liberica JDK 17.0.16。

在服务器上进入这两个文件所在的目录，首次部署时执行：

```sh
docker build -t sql-manager:1.0.0 .
docker run -d --name sql-manager --restart unless-stopped \
  -p 127.0.0.1:18080:18080 -v sql-manager-data:/data sql-manager:1.0.0
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:18080/api/health
```

应用只接受本机地址访问。部署到 220 后，可在本机运行 `ssh -N -L 18080:127.0.0.1:18080 suma@192.168.100.220`，再打开 **http://127.0.0.1:18080/**。

如需纳入 220 的现有 Compose 项目，将交付文件放到 `/opt/xt-deploy/services/sql-manager/`，将下列配置合并到 `/opt/xt-deploy/compose/docker-compose.yml` 的对应段落：

```yaml
services:
  sql-manager:
    build: /opt/xt-deploy/services/sql-manager
    image: xt/sql-manager:1.0.0
    container_name: sql-manager
    ports:
      - "127.0.0.1:18080:18080"
    volumes:
      - sql-manager-data:/data
    restart: unless-stopped
volumes:
  sql-manager-data:
    name: sql-manager-data
```

在 `/opt/xt-deploy/compose/` 执行 `docker compose up -d --build --no-deps sql-manager` 即可单独启动该服务。

### 本地 Compose

打包后在项目根目录运行：

```sh
docker compose up -d --build
```

同样访问 **http://127.0.0.1:18080/**。端口可用 `SQL_MANAGER_PORT=18081 docker compose up -d` 调整。镜像使用非 root 用户运行，数据保存在本机 Docker 命名卷 `sql-manager-data`，容器重建不会清空该卷。

```sh
docker compose down
```

不要在需要保留数据时执行 `docker compose down -v`。本地目录和 Docker 卷是两个独立工作区；迁移时使用页面中的完整备份与恢复。第一版默认仅映射本机回环地址，未提供多用户账户和公网访问能力。

## 首次使用

1. 在“SQL 文件”上传可信的全量基线，文件类型选择“安装基线”。支持 UTF-8 `.sql`，单文件上限 10 MiB，保留原始字节和 SHA-256。
2. 在“发布版本”创建首个版本，指定真实版本号并选择基线。发布后清单与文件冻结。
3. 新增本地、测试、阿里云或客户环境，填写实际数据库名和当前代码版本。
4. 已有数据库：核实结构与必要数据后“登记现有基线”，填写确认人和依据。全新空库：确认空库后生成首次安装包。
5. 后续变更上传为增量脚本，在新版本中确定顺序后发布。只有代码变化时也可以发布不含新增 SQL 的版本。
6. 选择目标环境与版本，预览并下载 ZIP。现场执行后，在交付包中逐文件登记成功、失败、部分执行或未执行。

实际库名写入交付说明；SQL 内的 `USE`、库名和语句不会被工具改写。交付包保留独立 SQL 文件，不合并、解析或自动生成回滚。

## 台账规则

- 导出不等于成功，只有人工登记更新 SQL 状态。代码版本单独编辑。
- 发布版本沿单条累计链继承，发布后不可变更；修正 SQL 通过新增文件和版本完成。
- 失败、部分执行及执行顺序断层必须先核实，不直接重新导出升级包。
- 登记修正追加审计记录，保留执行人、实际执行时间、登记时间和修正原因。
- 多标签页同时操作时，通过工作区 revision 检测冲突；旧请求不会覆盖新数据。
- 环境一旦有基线确认或交付记录，实际数据库名便不可修改；切换数据库时新增环境，保留原台账。

## 保存、备份与恢复

数据目录包含 `state.db`（SQLite 台账）、`scripts/`（原始 SQL）及运行锁文件。SQLite 使用事务保存一个带格式版本的工作区文档，SQL 内容不嵌入 JSON。此结构适合第一版的小型单人工作区。

“备份与设置 → 下载完整备份”导出一致的工作区记录和 SQL 原文件。恢复只允许进入空工作区，先验证 ZIP 路径、记录关系、文件大小和校验值，再整体写入。恢复已有数据时，先停止服务并改用新的空数据目录，避免覆盖现有记录。

在线完整备份与恢复支持最多 2,000 个 SQL 文件、16 MiB 的台账 JSON，以及 128 MiB 的原始内容总量和 ZIP 文件。超过此规模时，使用下述离线迁移方式。

不要在程序运行时只复制 `state.db`：SQLite 可能还存在 WAL 文件。优先使用工具提供的备份；离线迁移则停止服务后复制整个数据目录。每个数据目录只允许一个服务实例运行。

## 验证与项目结构

```sh
npm --prefix ui-prototype test
./scripts/build.sh
python3 scripts/smoke_test.py
docker build -t sql-manager:1.0.0 target/deploy
python3 scripts/docker_smoke_test.py
```

集成验收脚本会启动临时实例与临时数据目录，验证持久化、版本链、原文件 ZIP 校验、执行登记、冲突和备份恢复，不使用正式 `data/`。

Docker 验收使用独立临时容器和命名卷，验证删除容器后重新启动仍保留记录和 SQL 原文件，并自动清理本次验收资源。详见 [实施验收记录](docs/implementation-validation.md)。

- `backend/`：Java 17 / Spring Boot REST 服务与 SQLite 存储。
- `ui-prototype/`：正式前端源码；目录名沿用原型阶段，`design/` 保留选定方案与截图。
- `docs/api-contract.md`：前后端约定。
- `scripts/`：构建、启动与集成验收。

依赖文档：[Spring Boot 3.5](https://docs.spring.io/spring-boot/3.5/index.html)、[SQLite JDBC](https://github.com/xerial/sqlite-jdbc)。
