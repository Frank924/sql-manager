package com.sqlmanager;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

@Component
public class StateStore {
    public static final long MAX_SQL_BYTES = 10L * 1024 * 1024;
    private final ObjectMapper mapper;
    private final Path directory;
    private final Path filesDirectory;
    private FileChannel lockChannel;
    private FileLock fileLock;
    private Connection connection;
    private State current;

    public StateStore(ObjectMapper mapper, @Value("${sqlmanager.data-dir}") String dataDirectory) {
        this.mapper = mapper;
        directory = Path.of(dataDirectory).toAbsolutePath().normalize();
        filesDirectory = directory.resolve("scripts");
        try {
            Files.createDirectories(directory);
            if (Files.isSymbolicLink(directory.resolve(".lock")) || Files.isSymbolicLink(directory.resolve("state.db")) || Files.isSymbolicLink(filesDirectory)) {
                throw new IllegalStateException("数据目录中的数据库、锁文件和脚本目录不能是符号链接");
            }
            lockChannel = FileChannel.open(directory.resolve(".lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            fileLock = lockChannel.tryLock();
            if (fileLock == null) throw new IllegalStateException("此数据目录已由另一个 SQL Manager 实例使用");
            Files.createDirectories(filesDirectory);
            Class.forName("org.sqlite.JDBC");
            connection = DriverManager.getConnection("jdbc:sqlite:" + directory.resolve("state.db"));
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA journal_mode=WAL");
                statement.execute("PRAGMA synchronous=FULL");
                statement.execute("PRAGMA busy_timeout=5000");
                statement.execute("CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)");
            }
            try (var statement = connection.createStatement(); var row = statement.executeQuery("SELECT schema_version, revision, state_json FROM workspace WHERE id=1")) {
                if (row.next()) {
                    if (row.getInt(1) != 1) throw new IllegalStateException("不支持的数据格式版本");
                    current = mapper.readValue(row.getString(3), State.class);
                    if (current.schemaVersion != 1 || current.revision != row.getLong(2)) throw new IllegalStateException("工作区状态与数据库版本不一致");
                }
            }
            if (current == null) {
                current = new State();
                current.settings.dataDirectory = directory.toString();
                try (var statement = connection.prepareStatement("INSERT INTO workspace(id,schema_version,revision,state_json) VALUES(1,1,0,?)")) {
                    statement.setString(1, mapper.writeValueAsString(current));
                    statement.executeUpdate();
                }
            }
            current.settings.dataDirectory = directory.toString();
            for (var script : current.scripts) readOriginal(script);
            // An interrupted transaction can leave an unreferenced original, never a committed missing original.
            var referenced = current.scripts.stream().map(script -> script.id + ".sql").toList();
            try (var files = Files.list(filesDirectory)) {
                for (Path file : files.toList()) {
                    String name = file.getFileName().toString();
                    if ((name.startsWith(".pending-") || name.matches("[BS][0-9]{6}\\.sql") && !referenced.contains(name)) && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) Files.delete(file);
                }
            }
        } catch (Exception exception) {
            close();
            throw new IllegalStateException("无法打开 SQL Manager 数据目录：" + exception.getMessage(), exception);
        }
    }

    public Path directory() { return directory; }

    public synchronized State snapshot() { return copy(current); }

    public synchronized <T> T inspect(Function<State, T> reader) { return reader.apply(copy(current)); }

    @FunctionalInterface
    public interface Change { String apply(State state, Map<String, byte[]> newFiles); }

    public record Mutation(State state, String resultId) {}

    public synchronized Mutation change(long expectedRevision, Change change) {
        if (expectedRevision != current.revision) throw ApiException.conflict("数据已被其他操作更新，请刷新后重试；本次内容尚未保存。");
        State next = copy(current);
        Map<String, byte[]> newFiles = new LinkedHashMap<>();
        String resultId = change.apply(next, newFiles);
        next.schemaVersion = 1;
        next.revision = current.revision + 1;
        next.settings.dataDirectory = directory.toString();
        Mutation response = new Mutation(copy(next), resultId);
        List<Path> created = new ArrayList<>();
        try {
            connection.setAutoCommit(false);
            for (var entry : newFiles.entrySet()) {
                Path destination = originalPath(entry.getKey());
                if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) throw new IOException("原始 SQL 文件已存在");
                Path temporary = Files.createTempFile(filesDirectory, ".pending-", ".tmp");
                try {
                    try (var channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                        ByteBuffer bytes = ByteBuffer.wrap(entry.getValue());
                        while (bytes.hasRemaining()) channel.write(bytes);
                        channel.force(true);
                    }
                    Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE);
                    created.add(destination);
                } finally {
                    Files.deleteIfExists(temporary);
                }
            }
            if (!created.isEmpty()) {
                try (var directoryChannel = FileChannel.open(filesDirectory, StandardOpenOption.READ)) { directoryChannel.force(true); }
            }
            try (var statement = connection.prepareStatement("UPDATE workspace SET schema_version=1, revision=?, state_json=? WHERE id=1 AND revision=?")) {
                statement.setLong(1, next.revision);
                statement.setString(2, mapper.writeValueAsString(next));
                statement.setLong(3, current.revision);
                if (statement.executeUpdate() != 1) throw ApiException.conflict("持久化状态已改变，请重启并核对工作区。");
            }
            connection.commit();
            current = next;
            return response;
        } catch (Exception exception) {
            try { connection.rollback(); } catch (Exception ignored) { }
            for (var file : created) try { Files.deleteIfExists(file); } catch (IOException ignored) { }
            if (exception instanceof ApiException api) throw api;
            throw new ApiException(500, "保存失败，工作区未更新，请检查数据目录和磁盘空间。");
        } finally {
            try { connection.setAutoCommit(true); } catch (Exception ignored) { }
        }
    }

    public synchronized byte[] readOriginal(State.Script script) {
        Path path = originalPath(script.id);
        try {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > MAX_SQL_BYTES) throw new IOException("脚本文件缺失或类型无效");
            byte[] content = Files.readAllBytes(path);
            if (content.length != script.size || !sha256(content).equals(script.hash)) throw ApiException.conflict("SQL 原始文件校验失败：" + script.id + "，请从可信备份恢复。");
            return content;
        } catch (IOException exception) {
            throw ApiException.conflict("无法读取 SQL 原始文件：" + script.id + "，请检查数据目录。");
        }
    }

    private Path originalPath(String id) {
        if (id == null || !id.matches("[BS][0-9]{6}")) throw ApiException.bad("无效的 SQL 文件编号");
        return filesDirectory.resolve(id + ".sql");
    }

    private State copy(State state) { return mapper.convertValue(state, State.class); }

    public static String sha256(byte[] content) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content)); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }

    @PreDestroy
    public synchronized void close() {
        try { if (connection != null) connection.close(); } catch (Exception ignored) { }
        try { if (fileLock != null) fileLock.release(); } catch (Exception ignored) { }
        try { if (lockChannel != null) lockChannel.close(); } catch (Exception ignored) { }
    }
}
