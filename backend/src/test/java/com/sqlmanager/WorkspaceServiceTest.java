package com.sqlmanager;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceServiceTest {
    @TempDir Path temporary;
    private final ObjectMapper mapper = new ObjectMapper();
    private final byte[] baselineBytes = "\uFEFF-- 初始基线\r\nCREATE TABLE sample(id INT);\r\n".getBytes(StandardCharsets.UTF_8);

    private final class Fixture implements AutoCloseable {
        final StateStore store;
        final WorkspaceService service;
        Fixture(String directory) { this(temporary.resolve(directory)); }
        Fixture(Path directory) { store = new StateStore(mapper, directory.toString()); service = new WorkspaceService(store, mapper); }
        long revision() { return service.state().revision; }
        String upload(String name, String type, byte[] bytes) { return service.upload(revision(), name, "变更说明", "business", type, bytes).resultId(); }
        String increment(String name) { return upload(name + ".sql", "increment", ("-- " + name + "\nALTER TABLE sample ADD COLUMN " + name + " INT;").getBytes(StandardCharsets.UTF_8)); }
        void release(String id, String previous, String baseline, List<String> scripts) {
            service.saveRelease(revision(), null, releaseBody(id, previous, baseline, scripts));
            service.publish(revision(), id, json(Map.of()));
        }
        String environment(String name) { return service.saveEnvironment(revision(), null, envBody(name)).resultId(); }
        String install(String env, String target) { return service.createPackage(revision(), json(Map.of("envId", env, "target", target, "type", "install", "confirmedEmpty", true))).resultId(); }
        String upgrade(String env, String target) { return service.createPackage(revision(), json(Map.of("envId", env, "target", target, "type", "upgrade", "confirmedEmpty", false))).resultId(); }
        void result(String pkg, Map<String, String> results, String note) { service.register(revision(), pkg, json(Map.of("results", results, "operator", "Frank", "executedAt", "2025-01-01T12:30", "note", note))); }
        State.Environment env(String id) { return service.state().environments.stream().filter(env -> env.id.equals(id)).findFirst().orElseThrow(); }
        State.Delivery pkg(String id) { return service.state().packages.stream().filter(pkg -> pkg.id.equals(id)).findFirst().orElseThrow(); }
        @Override public void close() { store.close(); }
    }

    private JsonNode json(Object value) { return mapper.valueToTree(value); }
    private JsonNode envBody(String name) { return json(Map.of("name", name, "kind", "独立部署", "codeVersion", "v2.3.0", "actualDb", "lims-customer", "db", "business")); }
    private JsonNode releaseBody(String id, String previous, String baseline, List<String> scripts) {
        var body = new LinkedHashMap<String, Object>();
        body.put("id", id); body.put("name", "版本 " + id); body.put("previous", previous); body.put("baseline", baseline); body.put("scriptIds", scripts); body.put("notes", "发布说明");
        return json(body);
    }
    private static ApiException status(int expected, org.junit.jupiter.api.function.Executable action) {
        ApiException exception = assertThrows(ApiException.class, action);
        assertEquals(expected, exception.status, exception.getMessage()); return exception;
    }

    @Test void completeLifecyclePreservesOriginalsAndCorrectsResultsWithoutErasingAnotherPackage() throws Exception {
        Path directory = temporary.resolve("workspace");
        long savedRevision; String base, env, firstPackage;
        try (var fixture = new Fixture(directory)) {
            assertEquals(0, fixture.revision()); assertTrue(fixture.service.state().scripts.isEmpty());
            base = fixture.upload("基线.sql", "baseline", baselineBytes);
            assertFalse(fixture.service.state().scripts.get(0).frozen);
            assertEquals(StateStore.sha256(baselineBytes), fixture.service.state().scripts.get(0).hash);
            assertArrayEquals(baselineBytes, fixture.service.original(base).bytes());
            fixture.release("v2.3.0", null, base, List.of(base));
            assertTrue(fixture.service.state().scripts.get(0).frozen);
            env = fixture.environment("客户 A");
            fixture.service.baseline(fixture.revision(), env, json(Map.of("version", "v2.3.0", "operator", "Frank", "note", "核对了结构及必要数据", "confirmed", true)));
            assertEquals(List.of(base), fixture.env(env).baseApplied);
            assertEquals("baseline", fixture.env(env).history.get(0).type);
            String one = fixture.increment("first"), two = fixture.increment("second");
            fixture.release("v2.4.0", "v2.3.0", base, List.of(one, two));
            firstPackage = fixture.upgrade(env, "v2.4.0");
            String duplicate = fixture.upgrade(env, "v2.4.0");
            assertEquals(List.of(base), fixture.env(env).applied, "导出不改变台账");
            Map<String, byte[]> zip = unzip(fixture.service.packageZip(firstPackage));
            JsonNode manifest = mapper.readTree(zip.get("manifest.json"));
            assertEquals("lims-customer", manifest.path("actualDatabase").asText());
            assertEquals(one, manifest.path("scripts").get(0).path("id").asText());
            assertArrayEquals(fixture.service.original(one).bytes(), zip.get(manifest.path("scripts").get(0).path("file").asText()));
            fixture.result(firstPackage, Map.of(one, "partial", two, "notExecuted"), "首条部分执行，现场待核实");
            assertEquals(List.of(one), fixture.env(env).issues);
            status(409, () -> fixture.upgrade(env, "v2.4.0"));
            fixture.result(firstPackage, Map.of(one, "success", two, "success"), "现场补齐并核对成功");
            fixture.result(duplicate, Map.of(one, "notExecuted", two, "success"), "首项已在另一包执行");
            assertEquals(3, fixture.env(env).applied.size()); assertTrue(fixture.env(env).issues.isEmpty());
            assertEquals(2, fixture.pkg(firstPackage).registrations.size());
            assertEquals("partial", fixture.pkg(firstPackage).registrations.get(0).results.get(one));
            assertEquals("v2.3.0", fixture.env(env).codeVersion);
            savedRevision = fixture.revision();
        }
        try (var reopened = new Fixture(directory)) {
            assertEquals(savedRevision, reopened.revision());
            assertArrayEquals(baselineBytes, reopened.service.original(base).bytes());
            assertEquals(3, reopened.env(env).applied.size());
            assertEquals(2, reopened.pkg(firstPackage).registrations.size());
        }
    }

    @Test void firstInstallFailureAndBaselineCorrectionKeepLedgerTruthful() {
        try (var fixture = new Fixture("install")) {
            String base = fixture.upload("base.sql", "baseline", baselineBytes), increment = fixture.increment("next");
            fixture.release("7.2.1", null, base, List.of(base, increment));
            String env = fixture.environment("新客户");
            status(400, () -> fixture.service.createPackage(fixture.revision(), json(Map.of("envId", env, "target", "7.2.1", "type", "install", "confirmedEmpty", false))));
            String pkg = fixture.install(env, "7.2.1");
            fixture.result(pkg, Map.of(base, "partial", increment, "notExecuted"), "基线执行中断");
            assertNull(fixture.env(env).baseline); assertTrue(fixture.env(env).issues.contains(base));
            status(409, () -> fixture.install(env, "7.2.1"));
            fixture.result(pkg, Map.of(base, "notExecuted", increment, "success"), "核实发现登记顺序有误");
            assertNull(fixture.env(env).baseline); assertTrue(fixture.env(env).issues.contains(base), "基线缺口必须阻止普通导出");
            status(409, () -> fixture.upgrade(env, "7.2.1"));
            fixture.result(pkg, Map.of(base, "success", increment, "success"), "完整核对成功");
            assertEquals(base, fixture.env(env).baseline); assertTrue(fixture.env(env).issues.isEmpty());
            fixture.result(pkg, Map.of(base, "notExecuted", increment, "notExecuted"), "原登记环境选择错误，本环境从未执行");
            assertNull(fixture.env(env).baseline); assertTrue(fixture.env(env).applied.isEmpty()); assertTrue(fixture.env(env).issues.isEmpty());
            assertEquals("pending", fixture.pkg(pkg).status);
            assertEquals(4, fixture.pkg(pkg).registrations.size());
        }
    }

    @Test void releaseChainAllowsCodeOnlyVersionsAndRejectsInvalidMutation() {
        try (var fixture = new Fixture("releases")) {
            String base = fixture.upload("base.sql", "baseline", baselineBytes);
            fixture.release("v9.0.0", null, base, List.of(base));
            status(409, () -> fixture.service.saveRelease(fixture.revision(), "v9.0.0", releaseBody("v9.0.0", null, base, List.of(base))));
            fixture.release("v9.1.0", "v9.0.0", base, List.of());
            assertEquals(List.of(base), WorkspaceService.required(fixture.service.state(), "v9.1.0"));
            fixture.service.saveRelease(fixture.revision(), null, releaseBody("v9.2.0", "v9.0.0", base, List.of()));
            status(409, () -> fixture.service.publish(fixture.revision(), "v9.2.0", json(Map.of())));
            status(400, () -> fixture.service.saveRelease(fixture.revision(), null, releaseBody("v8.0.0", "v9.1.0", base, List.of())));
            String env = fixture.environment("客户");
            status(400, () -> fixture.service.saveEnvironment(fixture.revision(), env, json(Map.of("name", "客户", "kind", "独立部署", "db", "business", "actualDb", "lims", "applied", List.of(base)))));
            fixture.service.baseline(fixture.revision(), env, json(Map.of("version", "v9.1.0", "operator", "Frank", "note", "已核实", "confirmed", true)));
            status(409, () -> fixture.service.baseline(fixture.revision(), env, json(Map.of("version", "v9.1.0", "operator", "Frank", "note", "重复", "confirmed", true))));
            status(400, () -> fixture.upgrade(env, "v9.1.0"));
        }
    }

    @Test void multipleBaselineScriptsKeepTheirOrderThroughInstallUpgradeAndBackup() throws Exception {
        byte[] backup;
        String first, second, increment, env;
        try (var fixture = new Fixture("multiple-baselines")) {
            second = fixture.upload("结构.sql", "baseline", baselineBytes);
            first = fixture.upload("初始化.sql", "baseline", "-- 先初始化数据库\nCREATE DATABASE sample;\n".getBytes(StandardCharsets.UTF_8));
            increment = fixture.increment("next");
            var initial = List.of(first, second, increment);
            fixture.release("v1.0.0", null, first, initial);
            assertEquals(initial, WorkspaceService.required(fixture.service.state(), "v1.0.0"));
            assertTrue(fixture.service.state().scripts.stream().allMatch(script -> script.frozen));
            env = fixture.environment("多基线客户");
            String pkg = fixture.install(env, "v1.0.0");
            assertEquals(initial, fixture.pkg(pkg).scriptIds);
            var archive = unzip(fixture.service.packageZip(pkg));
            var manifest = mapper.readTree(archive.get("manifest.json")).path("scripts");
            for (int i = 0; i < initial.size(); i++) {
                assertEquals(initial.get(i), manifest.get(i).path("id").asText());
                assertArrayEquals(fixture.service.original(initial.get(i)).bytes(), archive.get(manifest.get(i).path("file").asText()));
            }
            fixture.result(pkg, Map.of(first, "success", second, "notExecuted", increment, "notExecuted"), "首个基线完成");
            assertEquals(first, fixture.env(env).baseline, "基线锚点必须遵循清单，而非上传顺序");
            String remaining = fixture.upgrade(env, "v1.0.0");
            assertEquals(List.of(second, increment), fixture.pkg(remaining).scriptIds);
            fixture.result(remaining, Map.of(second, "notExecuted", increment, "success"), "核实发现第二个基线被跳过");
            assertTrue(fixture.env(env).issues.contains(second));
            status(409, () -> fixture.upgrade(env, "v1.0.0"));
            fixture.result(remaining, Map.of(second, "success", increment, "success"), "补齐基线并核对成功");
            assertEquals(first, fixture.env(env).baseline);
            assertTrue(fixture.env(env).issues.isEmpty());
            fixture.release("v1.0.1", "v1.0.0", first, List.of());
            String next = fixture.increment("later");
            fixture.release("v1.1.0", "v1.0.1", first, List.of(next));
            assertEquals(List.of(first, second, increment, next), WorkspaceService.required(fixture.service.state(), "v1.1.0"));
            assertEquals(List.of(next), fixture.pkg(fixture.upgrade(env, "v1.1.0")).scriptIds);
            String existing = fixture.environment("已具备多基线的客户");
            fixture.service.baseline(fixture.revision(), existing, json(Map.of("version", "v1.0.0", "operator", "Frank", "note", "已核对全部基线及增量", "confirmed", true)));
            assertEquals(initial, fixture.env(existing).baseApplied);
            assertEquals(first, fixture.env(existing).baseline);
            backup = fixture.service.backup();
        }
        try (var restored = new Fixture("multiple-baselines-restored")) {
            restored.service.restore(0, true, new ByteArrayInputStream(backup));
            assertEquals(first, restored.env(env).baseline);
            assertTrue(restored.env(env).applied.containsAll(List.of(first, second, increment)));
            assertTrue(restored.env(env).issues.isEmpty());
            assertArrayEquals(baselineBytes, restored.service.original(second).bytes());
        }
    }

    @Test void baselineScriptsMustBeAUniquePrefixAndLaterReleasesCannotAddBaselines() {
        try (var fixture = new Fixture("baseline-order")) {
            String first = fixture.upload("first.sql", "baseline", baselineBytes);
            String second = fixture.upload("second.sql", "baseline", "-- 第二个基线\nINSERT INTO sample VALUES (1);\n".getBytes(StandardCharsets.UTF_8));
            String increment = fixture.increment("next");
            for (var ids : List.of(List.<String>of(), List.of(increment), List.of(second, first), List.of(first, increment, second), List.of(first, first))) {
                status(400, () -> fixture.service.saveRelease(fixture.revision(), null, releaseBody("v1.0.0", null, first, ids)));
            }
            fixture.release("v1.0.0", null, first, List.of(first, second));
            status(400, () -> fixture.service.saveRelease(fixture.revision(), null, releaseBody("v1.1.0", "v1.0.0", second, List.of(increment))));
            status(400, () -> fixture.service.saveRelease(fixture.revision(), null, releaseBody("v1.1.0", "v1.0.0", first, List.of(first))));
            String extra = fixture.upload("extra.sql", "baseline", "-- 新的基线\nINSERT INTO sample VALUES (2);\n".getBytes(StandardCharsets.UTF_8));
            status(400, () -> fixture.service.saveRelease(fixture.revision(), null, releaseBody("v1.1.0", "v1.0.0", first, List.of(extra))));
        }
    }

    @Test void backupRestoresToAnEmptyWorkspaceAndRejectsInvalidArchives() throws Exception {
        byte[] backup; String base;
        try (var fixture = new Fixture("source")) {
            base = fixture.upload("base.sql", "baseline", baselineBytes);
            fixture.release("v3.8.2", null, base, List.of(base));
            String env = fixture.environment("现场");
            String pkg = fixture.install(env, "v3.8.2");
            fixture.result(pkg, Map.of(base, "success"), "现场完成");
            fixture.increment("unpublished");
            backup = fixture.service.backup();
        }
        try (var restored = new Fixture("restored")) {
            restored.service.restore(0, true, new ByteArrayInputStream(backup));
            assertEquals(1, restored.revision()); assertEquals(2, restored.service.state().scripts.size());
            assertEquals(base, restored.service.state().environments.get(0).baseline);
            assertEquals(temporary.resolve("restored").toAbsolutePath().toString(), restored.service.state().settings.dataDirectory);
            assertArrayEquals(baselineBytes, restored.service.original(base).bytes());
            status(409, () -> restored.service.restore(restored.revision(), true, new ByteArrayInputStream(backup)));
        }
        try (var empty = new Fixture("invalid")) {
            status(400, () -> empty.service.restore(0, true, new ByteArrayInputStream("not a zip".getBytes(StandardCharsets.UTF_8))));
            status(400, () -> empty.service.restore(0, true, new ByteArrayInputStream(zip(Map.of("../escape", new byte[]{1})))));
            var entries = unzip(backup); entries.put("scripts/" + base + ".sql", "SELECT 1;".getBytes(StandardCharsets.UTF_8));
            byte[] tampered = zip(entries);
            status(400, () -> empty.service.restore(0, true, new ByteArrayInputStream(tampered)));
            assertEquals(0, empty.revision()); assertTrue(empty.service.state().scripts.isEmpty());
            assertFalse(Files.exists(temporary.resolve("escape")));
        }
    }

    @Test void uploadedFilesAreSafeAndHashTamperingBlocksPreviewExportAndBackup() throws Exception {
        try (var fixture = new Fixture("files")) {
            status(400, () -> fixture.upload("../escape.sql", "baseline", baselineBytes));
            status(400, () -> fixture.upload("bad.sql", "baseline", new byte[]{(byte)0xff}));
            status(413, () -> fixture.upload("large.sql", "baseline", new byte[(int) StateStore.MAX_SQL_BYTES + 1]));
            assertEquals(0, fixture.revision());
            String base = fixture.upload("base.sql", "baseline", baselineBytes);
            fixture.release("v1.0.0", null, base, List.of(base));
            String env = fixture.environment("环境"), pkg = fixture.install(env, "v1.0.0");
            Files.writeString(temporary.resolve("files/scripts/" + base + ".sql"), "-- tampered");
            status(409, () -> fixture.service.original(base));
            status(409, () -> fixture.service.packageZip(pkg));
            status(409, () -> fixture.service.backup());
        }
    }

    @Test void staleParallelWritesConflictAndSecondProcessCannotOpenTheSameDirectory() throws Exception {
        try (var fixture = new Fixture("concurrent")) {
            assertThrows(IllegalStateException.class, () -> new StateStore(mapper, temporary.resolve("concurrent").toString()));
            var executor = Executors.newFixedThreadPool(2); var start = new CountDownLatch(1);
            try {
                var futures = new ArrayList<java.util.concurrent.Future<Integer>>();
                for (int i = 0; i < 2; i++) {
                    int index = i;
                    futures.add(executor.submit(() -> { start.await(); try { fixture.service.saveEnvironment(0, null, envBody("环境 " + index)); return 200; } catch (ApiException exception) { return exception.status; } }));
                }
                start.countDown(); var statuses = new ArrayList<Integer>(); for (var future : futures) statuses.add(future.get());
                statuses.sort(Integer::compareTo); assertEquals(List.of(200, 409), statuses);
                assertEquals(1, fixture.revision()); assertEquals(1, fixture.service.state().environments.size());
            } finally { executor.shutdownNow(); }
        }
    }

    private static Map<String, byte[]> unzip(byte[] bytes) throws Exception {
        var entries = new LinkedHashMap<String, byte[]>();
        try (var input = new ZipInputStream(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8)) {
            ZipEntry entry; while ((entry = input.getNextEntry()) != null) entries.put(entry.getName(), input.readAllBytes());
        }
        return entries;
    }
    private static byte[] zip(Map<String, byte[]> entries) throws Exception {
        var output = new ByteArrayOutputStream();
        try (var zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
            for (var entry : entries.entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue()); zip.closeEntry(); }
        }
        return output.toByteArray();
    }
}
