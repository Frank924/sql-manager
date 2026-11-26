package com.sqlmanager;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.Map;

@RestControllerAdvice
public class ApiErrorHandler {
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, String>> api(ApiException exception) { return error(exception.status, exception.getMessage()); }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Map<String, String>> tooLarge(MaxUploadSizeExceededException exception) { return error(413, "上传文件超过允许大小"); }

    @ExceptionHandler({HttpMessageNotReadableException.class, MissingServletRequestParameterException.class,
            MissingServletRequestPartException.class, MethodArgumentTypeMismatchException.class, HttpMediaTypeNotSupportedException.class,
            MultipartException.class})
    public ResponseEntity<Map<String, String>> badRequest(Exception exception) { return error(400, "请求格式无效或缺少必要参数，请检查输入。"); }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Map<String, String>> notFound(NoResourceFoundException exception) { return error(404, "找不到请求的资源"); }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> unexpected(Exception exception) { return error(500, "操作失败，请检查服务状态及数据目录；本次内容可能尚未保存，请重新读取工作区核对。"); }

    private static ResponseEntity<Map<String, String>> error(int status, String message) { return ResponseEntity.status(status).body(Map.of("message", message)); }
}
