package com.sqlmanager;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final WorkspaceService workspace;
    public ApiController(WorkspaceService workspace) { this.workspace = workspace; }

    @GetMapping("/state") public State state() { return workspace.state(); }
    @GetMapping("/health") public Map<String, Object> health() { return Map.of("status", "ok", "schemaVersion", 1); }

    @PostMapping(value = "/scripts", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public StateStore.Mutation upload(@RequestHeader(value = "If-Match", required = false) String match,
            @RequestParam("file") MultipartFile file, @RequestParam("description") String description,
            @RequestParam("db") String db, @RequestParam("type") String type) throws IOException {
        long revision = revision(match);
        if (file.getSize() > StateStore.MAX_SQL_BYTES) throw new ApiException(413, "SQL 文件不能超过 10 MiB");
        return workspace.upload(revision, file.getOriginalFilename(), description, db, type, file.getBytes());
    }

    @GetMapping("/scripts/{id}/content") public ResponseEntity<byte[]> content(@PathVariable String id) {
        return ResponseEntity.ok().contentType(new MediaType("text", "plain", StandardCharsets.UTF_8))
                .header(HttpHeaders.CACHE_CONTROL, "no-store").body(workspace.original(id).bytes());
    }
    @GetMapping("/scripts/{id}/download") public ResponseEntity<byte[]> original(@PathVariable String id) {
        var file = workspace.original(id);
        return attachment(file.bytes(), file.name(), MediaType.APPLICATION_OCTET_STREAM);
    }

    @PostMapping("/releases") public StateStore.Mutation createRelease(@RequestHeader(value = "If-Match", required = false) String match, @RequestBody JsonNode body) {
        return workspace.saveRelease(revision(match), null, body);
    }
    @PutMapping("/releases/{id}") public StateStore.Mutation editRelease(@RequestHeader(value = "If-Match", required = false) String match, @PathVariable String id, @RequestBody JsonNode body) {
        return workspace.saveRelease(revision(match), id, body);
    }
    @PostMapping("/releases/{id}/publish") public StateStore.Mutation publish(@RequestHeader(value = "If-Match", required = false) String match, @PathVariable String id, @RequestBody JsonNode body) {
        return workspace.publish(revision(match), id, body);
    }
    @PostMapping("/environments") public StateStore.Mutation createEnvironment(@RequestHeader(value = "If-Match", required = false) String match, @RequestBody JsonNode body) {
        return workspace.saveEnvironment(revision(match), null, body);
    }
    @PutMapping("/environments/{id}") public StateStore.Mutation editEnvironment(@RequestHeader(value = "If-Match", required = false) String match, @PathVariable String id, @RequestBody JsonNode body) {
        return workspace.saveEnvironment(revision(match), id, body);
    }
    @PostMapping("/environments/{id}/baseline") public StateStore.Mutation baseline(@RequestHeader(value = "If-Match", required = false) String match, @PathVariable String id, @RequestBody JsonNode body) {
        return workspace.baseline(revision(match), id, body);
    }
    @PostMapping("/packages") public StateStore.Mutation createPackage(@RequestHeader(value = "If-Match", required = false) String match, @RequestBody JsonNode body) {
        return workspace.createPackage(revision(match), body);
    }
    @GetMapping("/packages/{id}/download") public ResponseEntity<byte[]> packageZip(@PathVariable String id) {
        return attachment(workspace.packageZip(id), id + ".zip", MediaType.parseMediaType("application/zip"));
    }
    @PostMapping("/packages/{id}/results") public StateStore.Mutation result(@RequestHeader(value = "If-Match", required = false) String match, @PathVariable String id, @RequestBody JsonNode body) {
        return workspace.register(revision(match), id, body);
    }
    @GetMapping("/backup") public ResponseEntity<byte[]> backup() {
        return attachment(workspace.backup(), "sql-manager-backup-" + LocalDate.now() + ".zip", MediaType.parseMediaType("application/zip"));
    }
    @PostMapping(value = "/restore", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public StateStore.Mutation restore(@RequestHeader(value = "If-Match", required = false) String match,
            @RequestParam("file") MultipartFile file, @RequestParam("confirmed") boolean confirmed) throws IOException {
        return workspace.restore(revision(match), confirmed, file.getInputStream());
    }

    private static long revision(String header) {
        if (header == null) throw ApiException.bad("请求必须包含 If-Match 工作区版本号");
        String value = header.trim();
        if (value.startsWith("\"") && value.endsWith("\"") && value.length() >= 2) value = value.substring(1, value.length() - 1);
        if (!value.matches("[0-9]{1,18}")) throw ApiException.bad("If-Match 版本号无效");
        try { return Long.parseLong(value); }
        catch (NumberFormatException exception) { throw ApiException.bad("If-Match 版本号无效"); }
    }
    private static ResponseEntity<byte[]> attachment(byte[] bytes, String name, MediaType type) {
        return ResponseEntity.ok().contentType(type).contentLength(bytes.length)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(name, StandardCharsets.UTF_8).build().toString())
                .header(HttpHeaders.CACHE_CONTROL, "no-store").body(bytes);
    }
}
