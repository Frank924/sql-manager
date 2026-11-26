package com.sqlmanager;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.util.Map;
import java.util.Set;

@Component
public class OriginFilter extends OncePerRequestFilter {
    private final ObjectMapper mapper;
    public OriginFilter(ObjectMapper mapper) { this.mapper = mapper; }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        if (request.getRequestURI().startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
        String origin = request.getHeader("Origin");
        if (request.getRequestURI().startsWith("/api/") && Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod()) && origin != null && !sameOrigin(origin, request)) {
            reject(response, "拒绝来自其他网站的写入请求"); return;
        }
        chain.doFilter(request, response);
    }

    private void reject(HttpServletResponse response, String message) throws IOException {
        response.setStatus(403); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8"); response.setHeader("Cache-Control", "no-store");
        mapper.writeValue(response.getOutputStream(), Map.of("message", message));
    }

    private boolean sameOrigin(String value, HttpServletRequest request) {
        try {
            URI origin = URI.create(value);
            if (origin.getUserInfo() != null || origin.getHost() == null || origin.getRawQuery() != null || origin.getRawFragment() != null || origin.getPath() != null && !origin.getPath().isEmpty()) return false;
            int port = origin.getPort() == -1 ? (origin.getScheme().equals("https") ? 443 : 80) : origin.getPort();
            return origin.getScheme().equalsIgnoreCase(request.getScheme()) && origin.getHost().equalsIgnoreCase(request.getServerName()) && port == request.getServerPort();
        } catch (RuntimeException exception) { return false; }
    }
}
