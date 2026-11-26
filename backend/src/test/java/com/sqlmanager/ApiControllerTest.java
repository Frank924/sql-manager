package com.sqlmanager;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ApiControllerTest {
    @TempDir Path directory;
    private final ObjectMapper mapper = new ObjectMapper();
    private StateStore store;
    private MockMvc api;
    private static final String ENVIRONMENT = "{\"name\":\"客户\",\"kind\":\"独立部署\",\"codeVersion\":\"\",\"actualDb\":\"lims\",\"db\":\"business\"}";

    @BeforeEach void start() {
        store = new StateStore(mapper, directory.toString());
        api = MockMvcBuilders.standaloneSetup(new ApiController(new WorkspaceService(store, mapper)))
                .setControllerAdvice(new ApiErrorHandler()).addFilters(new OriginFilter(mapper)).build();
    }
    @AfterEach void stop() { store.close(); }

    @Test void startsEmptyAndRequiresRevisionWithoutLeakingParserErrors() throws Exception {
        api.perform(get("/api/state")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.revision").value(0)).andExpect(jsonPath("$.scripts").isEmpty()).andExpect(jsonPath("$.environments").isEmpty());
        api.perform(post("/api/environments").contentType(MediaType.APPLICATION_JSON).content(ENVIRONMENT))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").isString());
        api.perform(post("/api/environments").header("If-Match", "0").contentType(MediaType.APPLICATION_JSON).content("{"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").isString()).andExpect(jsonPath("$.trace").doesNotExist());
        api.perform(post("/api/environments").header("If-Match", "0").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest());
        api.perform(post("/api/environments").header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON).content(ENVIRONMENT))
                .andExpect(status().isOk()).andExpect(jsonPath("$.state.revision").value(1)).andExpect(jsonPath("$.resultId").isString());
        api.perform(post("/api/environments").header("If-Match", "0").contentType(MediaType.APPLICATION_JSON).content(ENVIRONMENT))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.message").isString());
        assertEquals(1, store.snapshot().environments.size());
    }

    @Test void rejectsForeignOriginAndHostButAllowsSameOriginDevelopmentProxy() throws Exception {
        api.perform(post("/api/environments").header("Origin", "https://foreign.example").header("If-Match", "0").contentType(MediaType.APPLICATION_JSON).content(ENVIRONMENT))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.message").isString());
        api.perform(get("/api/state").with(request -> { request.setServerName("rebind.example"); return request; }))
                .andExpect(status().isForbidden()).andExpect(header().string("Cache-Control", "no-store"));
        api.perform(post("/api/environments").with(request -> { request.setServerName("localhost"); request.setServerPort(4173); return request; })
                        .header("Origin", "http://localhost:4173").header("If-Match", "0").contentType(MediaType.APPLICATION_JSON).content(ENVIRONMENT))
                .andExpect(status().isOk()).andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test void multipartUploadReturnsOriginalBytesAndReportsInvalidFiles() throws Exception {
        byte[] bytes = "\uFEFF-- 文件\r\nSELECT 1;\r\n".getBytes(StandardCharsets.UTF_8);
        var response = api.perform(multipart("/api/scripts").file(new MockMultipartFile("file", "initial.sql", "text/plain", bytes))
                        .param("description", "初始基线").param("db", "business").param("type", "baseline").header("If-Match", "0"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.state.scripts[0].frozen").value(false)).andReturn().getResponse();
        String id = mapper.readTree(response.getContentAsByteArray()).path("resultId").asText();
        assertArrayEquals(bytes, api.perform(get("/api/scripts/" + id + "/content")).andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray());
        assertArrayEquals(bytes, api.perform(get("/api/scripts/" + id + "/download")).andExpect(status().isOk()).andExpect(header().exists("Content-Disposition")).andReturn().getResponse().getContentAsByteArray());
        api.perform(multipart("/api/scripts").file(new MockMultipartFile("file", "large.sql", "text/plain", new byte[(int) StateStore.MAX_SQL_BYTES + 1]))
                        .param("description", "超限").param("db", "business").param("type", "increment").header("If-Match", "1"))
                .andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.message").isString());
        api.perform(get("/api/scripts/not-found/content")).andExpect(status().isNotFound());
        assertEquals(1, store.snapshot().revision);
    }
}
