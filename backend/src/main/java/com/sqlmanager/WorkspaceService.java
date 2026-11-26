package com.sqlmanager;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

@Service
public class WorkspaceService {
    private static final Set<String> RESULT_VALUES = Set.of("notExecuted", "success", "failed", "partial");
    private static final long MAX_BACKUP_BYTES = 128L * 1024 * 1024;
    private final StateStore store;
    private final ObjectMapper mapper;

    public WorkspaceService(StateStore store, ObjectMapper mapper) { this.store = store; this.mapper = mapper; }

    public State state() { return store.snapshot(); }

    public StateStore.Mutation upload(long revision, String name, String description, String db, String type, byte[] bytes) {
        validateSqlName(name);
        validateSql(bytes);
        validateDatabase(db);
        description = requiredText(description, "变更说明", 200);
        if (!Set.of("baseline", "increment").contains(type)) throw ApiException.bad("文件类型只能是 baseline 或 increment");
        final String detail = description;
        return store.change(revision, (state, files) -> {
            String hash = StateStore.sha256(bytes);
            if (state.scripts.stream().anyMatch(script -> script.db.equals(db) && script.hash.equals(hash))) throw ApiException.conflict("该目标库已存在相同内容的 SQL，请复用已有文件。");
            int number = state.scripts.stream().mapToInt(script -> Integer.parseInt(script.id.substring(1))).max().orElse(0) + 1;
            if (number > 999999) throw ApiException.bad("SQL 文件编号已达到上限");
            var script = new State.Script();
            script.id = (type.equals("baseline") ? "B" : "S") + String.format("%06d", number);
            script.name = name; script.description = detail; script.db = db; script.type = type;
            script.createdAt = now(); script.hash = hash; script.size = bytes.length; script.frozen = false;
            state.scripts.add(script);
            files.put(script.id, bytes);
            return script.id;
        });
    }

    public record Original(String name, byte[] bytes) {}
    public Original original(String id) {
        return store.inspect(state -> {
            var script = script(state, id);
            return new Original(script.name, store.readOriginal(script));
        });
    }

    public StateStore.Mutation saveRelease(long revision, String existingId, JsonNode body) {
        object(body, Set.of("id", "name", "previous", "baseline", "scriptIds", "notes"));
        String id = text(body, "id", 40);
        semanticVersion(id);
        if (existingId != null && !existingId.equals(id)) throw ApiException.bad("发布版本编号不可修改");
        String name = text(body, "name", 120);
        String previous = nullableText(body, "previous", 40);
        String baseline = text(body, "baseline", 40);
        List<String> ids = stringList(body.get("scriptIds"), "脚本清单");
        String notes = optionalText(body, "notes", 4000);
        return store.change(revision, (state, files) -> {
            State.Release existing = existingId == null ? null : release(state, existingId);
            if (existing != null && !"draft".equals(existing.status)) throw ApiException.conflict("已发布的清单不可修改，请创建新版本。");
            if (state.releases.stream().anyMatch(item -> !item.id.equals(existingId) && compareVersions(item.id, id) == 0)) throw ApiException.conflict("该发布版本已存在");
            var draft = new State.Release();
            draft.id = id; draft.name = name; draft.previous = previous; draft.baseline = baseline;
            draft.scriptIds = new ArrayList<>(ids); draft.notes = notes; draft.date = existing == null ? now() : existing.date; draft.status = "draft";
            validateRelease(state, draft);
            if (existing == null) state.releases.add(draft);
            else state.releases.set(state.releases.indexOf(existing), draft);
            return id;
        });
    }

    public StateStore.Mutation publish(long revision, String id, JsonNode body) {
        object(body, Set.of());
        return store.change(revision, (state, files) -> {
            var item = release(state, id);
            if (!"draft".equals(item.status)) throw ApiException.conflict("该版本已发布");
            var latest = latestPublished(state);
            if (!Objects.equals(item.previous, latest == null ? null : latest.id)) throw ApiException.conflict("请基于最新已发布版本重新整理草稿后发布。");
            validateRelease(state, item);
            for (String scriptId : required(state, id)) store.readOriginal(script(state, scriptId));
            item.status = "published"; item.date = now();
            for (String scriptId : item.scriptIds) script(state, scriptId).frozen = true;
            state.releases.remove(item); state.releases.add(item);
            return id;
        });
    }

    public StateStore.Mutation saveEnvironment(long revision, String id, JsonNode body) {
        object(body, Set.of("name", "kind", "codeVersion", "actualDb", "db"));
        String name = text(body, "name", 100), kind = text(body, "kind", 60), actualDb = text(body, "actualDb", 64), db = text(body, "db", 30);
        String codeVersion = optionalText(body, "codeVersion", 100);
        validateDatabase(db);
        if (!actualDb.matches("[\\p{L}\\p{N}_$-]{1,64}")) throw ApiException.bad("实际数据库名只能包含文字、数字、下划线、短横线和美元符号");
        return store.change(revision, (state, files) -> {
            var env = id == null ? new State.Environment() : environment(state, id);
            if (state.environments.stream().anyMatch(item -> !Objects.equals(item.id, id) && item.name.equalsIgnoreCase(name))) throw ApiException.conflict("环境名称已存在");
            boolean hasRecords = !env.baseApplied.isEmpty() || !env.applied.isEmpty() || !env.issues.isEmpty() || state.packages.stream().anyMatch(pkg -> pkg.envId.equals(id));
            if (id != null && hasRecords && (!env.actualDb.equals(actualDb) || !env.db.equals(db))) throw ApiException.conflict("已有交付或台账的数据库映射不可改写，请为另一个数据库新建环境。");
            if (id == null) { env.id = "ENV-" + UUID.randomUUID(); state.environments.add(env); }
            env.name = name; env.kind = kind; env.actualDb = actualDb; env.db = db; env.codeVersion = codeVersion;
            return env.id;
        });
    }

    public StateStore.Mutation baseline(long revision, String envId, JsonNode body) {
        object(body, Set.of("version", "operator", "note", "confirmed"));
        String version = text(body, "version", 40), operator = text(body, "operator", 100), note = text(body, "note", 4000);
        if (!booleanField(body, "confirmed")) throw ApiException.bad("请明确确认已核对现场结构及必要数据");
        return store.change(revision, (state, files) -> {
            var env = environment(state, envId);
            if (env.baseline != null || !env.baseApplied.isEmpty() || !env.applied.isEmpty() || !env.issues.isEmpty() || state.packages.stream().anyMatch(pkg -> pkg.envId.equals(envId))) throw ApiException.conflict("只有未接管且没有交付记录的环境可以登记现有基线。");
            var target = published(state, version);
            env.baseApplied = required(state, version); env.baseBaseline = target.baseline; env.baseVersion = version;
            reconcile(state, env);
            String recordedAt = now(); env.last = recordedAt;
            var event = new State.History();
            event.date = recordedAt; event.title = "确认达到 " + version; event.detail = "存量接管确认 · " + operator;
            event.type = "baseline"; event.operator = operator; event.note = note; event.version = version;
            env.history.add(0, event);
            return envId;
        });
    }

    public StateStore.Mutation createPackage(long revision, JsonNode body) {
        object(body, Set.of("envId", "target", "type", "confirmedEmpty"));
        String envId = text(body, "envId", 80), targetId = text(body, "target", 40), type = text(body, "type", 20);
        boolean emptyConfirmed = booleanField(body, "confirmedEmpty");
        if (!Set.of("install", "upgrade").contains(type)) throw ApiException.bad("无效的交付类型");
        return store.change(revision, (state, files) -> {
            var env = environment(state, envId); var target = published(state, targetId);
            if (!env.issues.isEmpty()) throw ApiException.conflict("存在失败或部分执行记录，请先核实并修正登记。");
            var required = required(state, targetId);
            if (type.equals("install")) {
                if (!emptyConfirmed) throw ApiException.bad("请明确确认目标数据库是全新空库");
                if (env.baseline != null || !env.baseApplied.isEmpty() || !env.applied.isEmpty()) throw ApiException.conflict("已有基线或执行记录的环境不能首次安装。");
            } else {
                if (env.baseline == null) throw ApiException.conflict("请先登记现有基线，或为全新空库选择首次安装。");
                if (!env.baseline.equals(target.baseline)) throw ApiException.conflict("环境基线与目标发布不一致");
                if (!required.containsAll(env.applied)) throw ApiException.conflict("目标版本未包含已执行的部分变更，不支持降级。");
                boolean gap = false;
                for (String id : required) {
                    if (!env.applied.contains(id)) gap = true;
                    else if (gap) throw ApiException.conflict("执行台账存在跳过的前序脚本，请先核实登记。");
                }
            }
            var ids = new ArrayList<>(required);
            if (type.equals("upgrade")) ids.removeAll(env.applied);
            if (ids.isEmpty()) throw ApiException.bad("该环境已具备目标版本的全部 SQL，无需生成交付包。");
            var pkg = new State.Delivery();
            pkg.id = "PKG-" + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").format(LocalDateTime.now()) + "-" + UUID.randomUUID().toString().substring(0, 8);
            pkg.envId = env.id; pkg.envName = env.name; pkg.target = targetId; pkg.type = type; pkg.db = env.db; pkg.actualDb = env.actualDb;
            pkg.scriptIds = ids; pkg.inputApplied = new ArrayList<>(env.applied); pkg.inputBaseline = env.baseline; pkg.createdAt = now(); pkg.status = "pending";
            pkg.environmentSnapshot = new State.EnvironmentSnapshot();
            pkg.environmentSnapshot.id = env.id; pkg.environmentSnapshot.name = env.name; pkg.environmentSnapshot.db = env.db;
            pkg.environmentSnapshot.actualDb = env.actualDb; pkg.environmentSnapshot.codeVersion = env.codeVersion; pkg.environmentSnapshot.baseline = env.baseline;
            for (String id : ids) {
                var file = script(state, id); store.readOriginal(file);
                pkg.files.add(mapper.convertValue(file, State.Script.class));
            }
            state.packages.add(0, pkg);
            return pkg.id;
        });
    }

    public StateStore.Mutation register(long revision, String packageId, JsonNode body) {
        object(body, Set.of("results", "operator", "executedAt", "note"));
        String operator = text(body, "operator", 100), executedAt = executionTime(text(body, "executedAt", 50));
        String note = optionalText(body, "note", 4000);
        JsonNode resultsNode = body.get("results");
        if (resultsNode == null || !resultsNode.isObject()) throw ApiException.bad("请逐文件填写执行结果");
        Map<String, String> results = new LinkedHashMap<>();
        resultsNode.fields().forEachRemaining(entry -> {
            if (!entry.getValue().isTextual() || !RESULT_VALUES.contains(entry.getValue().asText())) throw ApiException.bad("无效的执行结果");
            results.put(entry.getKey(), entry.getValue().asText());
        });
        return store.change(revision, (state, files) -> {
            var pkg = delivery(state, packageId);
            if (!new HashSet<>(pkg.scriptIds).equals(results.keySet())) throw ApiException.bad("必须且只能登记此交付包中的全部脚本");
            boolean correction = !pkg.registrations.isEmpty();
            boolean issue = results.values().stream().anyMatch(value -> value.equals("failed") || value.equals("partial"));
            if (!correction && results.values().stream().allMatch(value -> value.equals("notExecuted"))) throw ApiException.bad("请至少登记一个实际执行结果");
            if ((correction || issue) && note.isBlank()) throw ApiException.bad(correction ? "修正登记必须填写原因" : "失败或部分执行必须填写说明");
            for (var file : pkg.files) store.readOriginal(file);
            var registration = new State.Registration();
            registration.results = new LinkedHashMap<>(results); registration.operator = operator; registration.executedAt = executedAt;
            registration.note = note; registration.recordedAt = now();
            pkg.registrations.add(registration);
            pkg.results = new LinkedHashMap<>(results); pkg.operator = operator; pkg.executedAt = executedAt; pkg.note = note; pkg.status = resultStatus(results);
            var env = environment(state, pkg.envId); reconcile(state, env); env.last = registration.recordedAt;
            var event = new State.History();
            event.date = registration.recordedAt; event.type = correction ? "correction" : "execution"; event.title = pkg.id + (correction ? " 修正登记" : " 执行结果登记");
            event.operator = operator; event.note = note; event.detail = operator + " · " + (issue ? "存在待核实项" : pkg.status.equals("completed") ? "全部成功" : "部分文件已登记");
            env.history.add(0, event);
            return pkg.id;
        });
    }

    public byte[] packageZip(String id) {
        return store.inspect(state -> {
            var pkg = delivery(state, id);
            try {
                var output = new ByteArrayOutputStream();
                try (var zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
                    List<Map<String, Object>> entries = new ArrayList<>();
                    StringBuilder csv = new StringBuilder("脚本编号,文件名,执行结果,执行时间,执行人,备注\r\n");
                    for (int i = 0; i < pkg.files.size(); i++) {
                        var file = pkg.files.get(i); String path = "sql/" + String.format("%03d_", i + 1) + file.name;
                        zipEntry(zip, path, store.readOriginal(file));
                        entries.add(Map.of("order", i + 1, "id", file.id, "file", path, "sha256", file.hash, "size", file.size, "database", file.db));
                        csv.append(csv(file.id)).append(',').append(csv(file.name)).append(",未执行,,,\r\n");
                    }
                    var manifest = new LinkedHashMap<String, Object>();
                    manifest.put("schemaVersion", 1); manifest.put("packageId", pkg.id); manifest.put("environment", pkg.environmentSnapshot);
                    manifest.put("targetRelease", pkg.target); manifest.put("type", pkg.type); manifest.put("database", pkg.db); manifest.put("actualDatabase", pkg.actualDb);
                    manifest.put("createdAt", pkg.createdAt); manifest.put("inputApplied", pkg.inputApplied); manifest.put("inputBaseline", pkg.inputBaseline); manifest.put("scripts", entries);
                    zipEntry(zip, "manifest.json", mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
                    zipEntry(zip, "执行说明.txt", ("SQL Manager 交付包\n环境：" + pkg.envName + "\n目标数据库：" + pkg.actualDb + "\n逻辑库：" + pkg.db + "\n目标版本：" + pkg.target + "\n\n执行前核对数据库及现场状态。按 manifest.json 顺序执行原始 SQL；遇错立即停止，并核实已生效语句。\n本工具不执行 SQL。导出不等于执行成功，现场执行后须逐文件登记结果。\n").getBytes(StandardCharsets.UTF_8));
                    zipEntry(zip, "执行结果登记表.csv", csv.toString().getBytes(StandardCharsets.UTF_8));
                }
                return output.toByteArray();
            } catch (IOException exception) { throw new ApiException(500, "生成交付包失败"); }
        });
    }

    public byte[] backup() {
        return store.inspect(state -> {
            try {
                long size = state.scripts.stream().mapToLong(script -> script.size).sum();
                byte[] stateJson = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(state);
                if (state.scripts.size() > 2000 || stateJson.length > 16 * 1024 * 1024 || size + stateJson.length > MAX_BACKUP_BYTES) throw new ApiException(413, "工作区超过在线备份容量，请停机复制整个数据目录。");
                var output = new ByteArrayOutputStream();
                try (var zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
                    zipEntry(zip, "state.json", stateJson);
                    for (var script : state.scripts) zipEntry(zip, "scripts/" + script.id + ".sql", store.readOriginal(script));
                }
                if (output.size() > MAX_BACKUP_BYTES) throw new ApiException(413, "备份 ZIP 超过在线恢复容量，请停机复制整个数据目录。");
                return output.toByteArray();
            } catch (IOException exception) { throw new ApiException(500, "生成一致性备份失败"); }
        });
    }

    public StateStore.Mutation restore(long revision, boolean confirmed, InputStream input) {
        if (!confirmed) throw ApiException.bad("请明确确认恢复备份");
        Map<String, byte[]> entries = readBackup(input);
        byte[] json = entries.remove("state.json");
        if (json == null) throw ApiException.bad("备份缺少 state.json");
        final State restored;
        try { restored = mapper.readValue(json, State.class); }
        catch (Exception exception) { throw ApiException.bad("备份状态格式无效"); }
        validateRestore(restored, entries);
        return store.change(revision, (state, files) -> {
            if (!state.scripts.isEmpty() || !state.releases.isEmpty() || !state.environments.isEmpty() || !state.packages.isEmpty()) throw ApiException.conflict("只能恢复到空工作区，现有数据不会被覆盖。");
            state.scripts = restored.scripts; state.releases = restored.releases; state.environments = restored.environments; state.packages = restored.packages;
            state.settings.workspaceName = restored.settings.workspaceName;
            for (var script : restored.scripts) files.put(script.id, entries.get("scripts/" + script.id + ".sql"));
            return "workspace";
        });
    }

    private void validateRelease(State state, State.Release item) {
        semanticVersion(item.id);
        if (new HashSet<>(item.scriptIds).size() != item.scriptIds.size()) throw ApiException.bad("发布清单不能重复引用脚本");
        var base = script(state, item.baseline);
        if (!base.type.equals("baseline")) throw ApiException.bad("请选择基线类型的 SQL 文件");
        if (item.previous == null) {
            if (state.releases.stream().anyMatch(release -> release.status.equals("published") && !release.id.equals(item.id))) throw ApiException.bad("后续发布必须指定前一已发布版本");
            if (item.scriptIds.isEmpty() || !item.scriptIds.get(0).equals(item.baseline)) throw ApiException.bad("首个发布必须以所选安装基线的第一个脚本开始");
            boolean incrementsStarted = false;
            for (String id : item.scriptIds) {
                if (script(state, id).type.equals("baseline")) {
                    if (incrementsStarted) throw ApiException.bad("安装基线脚本必须全部排在增量脚本之前");
                } else incrementsStarted = true;
            }
        } else {
            var parent = published(state, item.previous);
            if (compareVersions(item.id, parent.id) <= 0) throw ApiException.bad("版本号必须高于前一发布版本");
            if (!item.baseline.equals(parent.baseline)) throw ApiException.bad("后续发布必须继承前一版本的基线");
            var inherited = required(state, parent.id);
            if (item.scriptIds.stream().anyMatch(inherited::contains)) throw ApiException.bad("本次新增清单不能重复包含已继承脚本");
            if (item.scriptIds.stream().anyMatch(id -> script(state, id).type.equals("baseline"))) throw ApiException.bad("后续发布只能新增增量脚本");
        }
        for (String id : item.scriptIds) script(state, id);
    }

    public static List<String> required(State state, String id) {
        var path = new ArrayList<State.Release>(); var visited = new HashSet<String>();
        while (id != null) {
            if (!visited.add(id)) throw ApiException.bad("发布链存在循环引用");
            var item = release(state, id); path.add(item); id = item.previous;
        }
        var ids = new LinkedHashSet<String>();
        for (int i = path.size() - 1; i >= 0; i--) ids.addAll(path.get(i).scriptIds);
        return new ArrayList<>(ids);
    }

    public static void reconcile(State state, State.Environment env) {
        var applied = new LinkedHashSet<>(env.baseApplied); var issues = new LinkedHashSet<String>();
        for (var pkg : state.packages) {
            if (!pkg.envId.equals(env.id)) continue;
            for (var result : pkg.results.entrySet()) {
                if (result.getValue().equals("success")) applied.add(result.getKey());
                if (result.getValue().equals("failed") || result.getValue().equals("partial")) issues.add(result.getKey());
            }
        }
        env.applied = new ArrayList<>(applied); env.issues = new ArrayList<>(issues);
        var latest = latestPublished(state);
        env.baseline = env.baseBaseline != null ? env.baseBaseline : latest != null && applied.contains(latest.baseline) ? latest.baseline : null;
        if (latest != null) {
            var missing = new ArrayList<String>();
            for (String id : required(state, latest.id)) {
                if (!applied.contains(id)) missing.add(id);
                else issues.addAll(missing);
            }
            env.issues = new ArrayList<>(issues);
        }
    }

    private Map<String, byte[]> readBackup(InputStream input) {
        var entries = new LinkedHashMap<String, byte[]>(); long total = 0;
        try (var zip = new ZipInputStream(input, StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (entry.isDirectory() || !(name.equals("state.json") || name.matches("scripts/[BS][0-9]{6}\\.sql"))) throw ApiException.bad("备份包含非法路径或未知文件");
                if (entries.containsKey(name) || entries.size() >= 2001) throw ApiException.bad("备份包含重复文件或文件数量过多");
                long limit = name.equals("state.json") ? 16L * 1024 * 1024 : StateStore.MAX_SQL_BYTES;
                var bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
                while ((count = zip.read(buffer)) != -1) {
                    total += count;
                    if (bytes.size() + (long) count > limit || total > MAX_BACKUP_BYTES) throw new ApiException(413, "备份解压后超过容量限制");
                    bytes.write(buffer, 0, count);
                }
                entries.put(name, bytes.toByteArray()); zip.closeEntry();
            }
        } catch (ApiException exception) { throw exception; }
        catch (IOException exception) { throw ApiException.bad("无法读取 ZIP 备份，文件可能损坏"); }
        if (entries.isEmpty()) throw ApiException.bad("不是有效的 SQL Manager ZIP 备份");
        return entries;
    }

    private void validateRestore(State state, Map<String, byte[]> originals) {
        try {
            if (state == null || state.schemaVersion != 1 || state.revision < 0 || state.scripts == null || state.releases == null || state.environments == null || state.packages == null || state.settings == null) throw ApiException.bad("备份数据格式版本无效");
            requiredText(state.settings.workspaceName, "工作区名称", 120);
            unique(state.scripts.stream().map(script -> script.id).toList(), "脚本");
            unique(state.releases.stream().map(release -> release.id).toList(), "发布版本");
            unique(state.environments.stream().map(env -> env.id).toList(), "环境");
            unique(state.packages.stream().map(pkg -> pkg.id).toList(), "交付包");
            if (originals.size() != state.scripts.size()) throw ApiException.bad("备份原始文件数量与清单不一致");
            for (var script : state.scripts) {
                if (!script.id.matches("[BS][0-9]{6}") || !Set.of("baseline", "increment").contains(script.type) || !(script.type.equals("baseline") ? script.id.startsWith("B") : script.id.startsWith("S"))) throw ApiException.bad("备份 SQL 元数据无效");
                validateDatabase(script.db); validateSqlName(script.name); requiredText(script.description, "变更说明", 200); Instant.parse(script.createdAt);
                byte[] bytes = originals.get("scripts/" + script.id + ".sql");
                if (bytes == null || bytes.length != script.size || !StateStore.sha256(bytes).equals(script.hash)) throw ApiException.bad("备份 SQL 校验失败：" + script.id);
                validateSql(bytes);
            }
            State.Release previousPublished = null;
            for (var item : state.releases) {
                if (!Set.of("draft", "published").contains(item.status)) throw ApiException.bad("备份发布状态无效");
                requiredText(item.name, "版本名称", 120); Instant.parse(item.date);
                if (item.status.equals("published")) {
                    if (!Objects.equals(item.previous, previousPublished == null ? null : previousPublished.id)) throw ApiException.bad("备份已发布版本不是连续升级链");
                    for (String id : item.scriptIds) if (!script(state, id).frozen) throw ApiException.bad("备份已发布脚本未冻结");
                    previousPublished = item;
                }
                // Validate initial releases without treating their already-published successors as predecessors.
                var subset = mapper.convertValue(state, State.class);
                if (item.previous == null) subset.releases.removeIf(release -> !release.id.equals(item.id));
                validateRelease(subset, item); required(state, item.id);
            }
            for (var env : state.environments) {
                requiredText(env.id, "环境编号", 80); requiredText(env.name, "环境名称", 100); requiredText(env.kind, "环境类型", 60);
                validateDatabase(env.db); requiredText(env.actualDb, "实际库名", 64);
                unique(env.baseApplied, "基线脚本"); unique(env.applied, "已执行脚本"); unique(env.issues, "待核实脚本");
                if (env.history == null || env.codeVersion == null) throw ApiException.bad("备份环境数据缺失");
                for (String id : env.baseApplied) script(state, id);
                if (env.baseBaseline == null) {
                    if (!env.baseApplied.isEmpty() || env.baseVersion != null) throw ApiException.bad("备份接管基线不完整");
                } else {
                    var base = published(state, env.baseVersion);
                    if (!base.baseline.equals(env.baseBaseline) || !required(state, base.id).equals(env.baseApplied)) throw ApiException.bad("备份接管版本与基线不一致");
                }
            }
            for (var pkg : state.packages) {
                var env = environment(state, pkg.envId); var target = published(state, pkg.target);
                if (!Set.of("install", "upgrade").contains(pkg.type) || !pkg.db.equals(env.db) || !pkg.actualDb.equals(env.actualDb) || pkg.environmentSnapshot == null || !pkg.environmentSnapshot.id.equals(env.id) || !pkg.environmentSnapshot.actualDb.equals(pkg.actualDb)) throw ApiException.bad("备份交付环境不一致");
                Instant.parse(pkg.createdAt); unique(pkg.scriptIds, "交付脚本"); unique(pkg.inputApplied, "来源台账");
                var required = required(state, target.id);
                if (pkg.scriptIds.isEmpty() || !required.containsAll(pkg.scriptIds) || !required.containsAll(pkg.inputApplied)) throw ApiException.bad("备份交付脚本不属于目标版本");
                var expected = new ArrayList<>(required); if (pkg.type.equals("upgrade")) expected.removeAll(pkg.inputApplied);
                if (!expected.equals(pkg.scriptIds) || pkg.files.size() != pkg.scriptIds.size()) throw ApiException.bad("备份交付顺序不一致");
                for (int i = 0; i < pkg.files.size(); i++) {
                    var file = pkg.files.get(i); var original = script(state, pkg.scriptIds.get(i));
                    if (!file.id.equals(original.id) || !file.hash.equals(original.hash) || file.size != original.size || !file.name.equals(original.name) || !file.db.equals(original.db)) throw ApiException.bad("备份交付文件快照不一致");
                }
                if (!pkg.results.isEmpty()) validResults(pkg.scriptIds, pkg.results);
                if (!resultStatus(pkg.results).equals(pkg.status)) throw ApiException.bad("备份交付状态不一致");
                for (var event : pkg.registrations) { validResults(pkg.scriptIds, event.results); requiredText(event.operator, "执行人", 100); executionTime(event.executedAt); Instant.parse(event.recordedAt); }
                if (pkg.registrations.isEmpty()) {
                    if (!pkg.results.isEmpty()) throw ApiException.bad("备份执行结果缺少审计记录");
                } else {
                    var last = pkg.registrations.get(pkg.registrations.size() - 1);
                    if (!last.results.equals(pkg.results) || !Objects.equals(last.operator, pkg.operator) || !Objects.equals(last.executedAt, pkg.executedAt) || !Objects.equals(last.note, pkg.note)) throw ApiException.bad("备份最新登记与审计记录不一致");
                }
            }
            for (var env : state.environments) {
                var actual = mapper.convertValue(env, State.Environment.class); reconcile(state, actual);
                if (!new HashSet<>(actual.applied).equals(new HashSet<>(env.applied)) || !new HashSet<>(actual.issues).equals(new HashSet<>(env.issues)) || !Objects.equals(actual.baseline, env.baseline)) throw ApiException.bad("备份环境状态与执行记录不一致");
            }
        } catch (ApiException exception) { throw ApiException.bad(exception.getMessage()); }
        catch (RuntimeException exception) { throw ApiException.bad("备份数据缺失或存在无效关联"); }
    }

    private static void validResults(List<String> ids, Map<String, String> results) {
        if (!new HashSet<>(ids).equals(results.keySet()) || !RESULT_VALUES.containsAll(results.values())) throw ApiException.bad("备份执行结果无效");
    }
    private static String resultStatus(Map<String, String> results) {
        if (results.isEmpty() || results.values().stream().allMatch(value -> value.equals("notExecuted"))) return "pending";
        if (results.values().stream().allMatch(value -> value.equals("success"))) return "completed";
        if (results.values().stream().anyMatch(value -> value.equals("failed") || value.equals("partial"))) return "issue";
        return "partial";
    }
    private static State.Script script(State state, String id) { return state.scripts.stream().filter(item -> item.id.equals(id)).findFirst().orElseThrow(() -> ApiException.missing("找不到 SQL 文件：" + id)); }
    private static State.Release release(State state, String id) { return state.releases.stream().filter(item -> item.id.equals(id)).findFirst().orElseThrow(() -> ApiException.missing("找不到发布版本：" + id)); }
    private static State.Release published(State state, String id) { var item = release(state, id); if (!item.status.equals("published")) throw ApiException.bad("请选择已发布版本"); return item; }
    private static State.Release latestPublished(State state) { return state.releases.stream().filter(item -> item.status.equals("published")).reduce((first, second) -> second).orElse(null); }
    private static State.Environment environment(State state, String id) { return state.environments.stream().filter(item -> item.id.equals(id)).findFirst().orElseThrow(() -> ApiException.missing("找不到目标环境")); }
    private static State.Delivery delivery(State state, String id) { return state.packages.stream().filter(item -> item.id.equals(id)).findFirst().orElseThrow(() -> ApiException.missing("找不到交付包")); }
    private static void validateDatabase(String db) { if (!"business".equals(db)) throw ApiException.bad("第一版仅支持 business 逻辑库"); }
    private static void validateSqlName(String name) {
        if (name == null || name.length() > 180 || !name.toLowerCase().endsWith(".sql") || name.contains("/") || name.contains("\\") || name.contains("..") || name.chars().anyMatch(Character::isISOControl)) throw ApiException.bad("请选择名称有效的 .sql 文件，文件名不能包含路径或控制字符");
    }
    private static void validateSql(byte[] bytes) {
        if (bytes.length > StateStore.MAX_SQL_BYTES) throw new ApiException(413, "SQL 文件不能超过 10 MiB");
        if (bytes.length == 0) throw ApiException.bad("SQL 文件不能为空");
        try {
            String content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if (content.replace("\uFEFF", "").isBlank() || content.indexOf('\0') >= 0) throw ApiException.bad("SQL 文件为空或包含无效字符");
        } catch (CharacterCodingException exception) { throw ApiException.bad("SQL 必须使用有效的 UTF-8 编码"); }
    }
    private static void semanticVersion(String id) {
        if (id == null || !id.matches("v?(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})")) throw ApiException.bad("版本号请使用 v1.2.3 或 1.2.3 格式");
    }
    private static int compareVersions(String first, String second) {
        semanticVersion(first); semanticVersion(second);
        String[] a = first.replaceFirst("^v", "").split("\\."), b = second.replaceFirst("^v", "").split("\\.");
        for (int i = 0; i < 3; i++) { int comparison = Integer.compare(Integer.parseInt(a[i]), Integer.parseInt(b[i])); if (comparison != 0) return comparison; }
        return 0;
    }
    private static void object(JsonNode body, Set<String> allowed) {
        if (body == null || !body.isObject()) throw ApiException.bad("请提供 JSON 对象请求体");
        body.fieldNames().forEachRemaining(key -> { if (!allowed.contains(key)) throw ApiException.bad("请求中包含不允许修改的字段：" + key); });
    }
    private static String text(JsonNode body, String key, int max) {
        JsonNode value = body.get(key); if (value == null || !value.isTextual()) throw ApiException.bad("缺少或无效字段：" + key);
        return requiredText(value.asText(), key, max);
    }
    private static String requiredText(String value, String key, int max) {
        if (value == null || value.isBlank() || value.length() > max || value.indexOf('\0') >= 0) throw ApiException.bad("字段为空或长度无效：" + key);
        return value.trim();
    }
    private static String optionalText(JsonNode body, String key, int max) {
        JsonNode value = body.get(key); if (value == null || value.isNull()) return "";
        if (!value.isTextual() || value.asText().length() > max || value.asText().indexOf('\0') >= 0) throw ApiException.bad("无效字段：" + key);
        return value.asText().trim();
    }
    private static String nullableText(JsonNode body, String key, int max) { String value = optionalText(body, key, max); return value.isEmpty() ? null : value; }
    private static boolean booleanField(JsonNode body, String key) { JsonNode value = body.get(key); if (value == null) return false; if (!value.isBoolean()) throw ApiException.bad("无效的确认字段：" + key); return value.asBoolean(); }
    private static List<String> stringList(JsonNode node, String label) {
        if (node == null || !node.isArray() || node.size() > 2000) throw ApiException.bad(label + "必须是数组且不超过 2000 项");
        var values = new ArrayList<String>(); for (var value : node) { if (!value.isTextual() || value.asText().isBlank()) throw ApiException.bad(label + "包含无效编号"); values.add(value.asText()); } return values;
    }
    private static void unique(List<String> values, String label) { if (values == null || values.stream().anyMatch(value -> value == null || value.isBlank()) || new HashSet<>(values).size() != values.size()) throw ApiException.bad(label + "包含空值或重复编号"); }
    private static String executionTime(String input) {
        try {
            LocalDateTime time = LocalDateTime.parse(input.trim().replace(' ', 'T'));
            if (time.atZone(ZoneId.systemDefault()).toInstant().isAfter(Instant.now().plusSeconds(60))) throw ApiException.bad("实际执行时间不能晚于当前时间");
            return time.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
        } catch (ApiException exception) { throw exception; }
        catch (RuntimeException exception) { throw ApiException.bad("执行时间请使用 yyyy-MM-dd HH:mm 格式"); }
    }
    private static String now() { return Instant.now().toString(); }
    private static void zipEntry(ZipOutputStream zip, String name, byte[] bytes) throws IOException { zip.putNextEntry(new ZipEntry(name)); zip.write(bytes); zip.closeEntry(); }
    private static String csv(String value) { return '"' + value.replace("\"", "\"\"") + '"'; }
}
