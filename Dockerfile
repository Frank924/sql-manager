FROM bellsoft/liberica-openjdk-rocky:17.0.16-cds
WORKDIR /app
RUN groupadd --gid 10001 sqlmanager && useradd --uid 10001 --gid sqlmanager --no-create-home sqlmanager && mkdir /data && chown sqlmanager:sqlmanager /data
COPY sql-manager.jar /app/sql-manager.jar
ENV DATA_DIR=/data SERVER_ADDRESS=0.0.0.0 SERVER_PORT=18080 TZ=Asia/Shanghai
USER sqlmanager
EXPOSE 18080
ENTRYPOINT ["java", "-jar", "/app/sql-manager.jar"]
