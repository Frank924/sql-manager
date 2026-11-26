#!/usr/bin/env python3
"""Verify packaged UI and named-volume persistence using an existing Docker image.

Usage: python3 scripts/docker_smoke_test.py [--image sql-manager:1.0.0]
Creates two dedicated containers in sequence and one dedicated named volume.
All published ports bind only to 127.0.0.1. Only resources carrying this run's
unique ownership label are removed, including when a check fails.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import uuid

sys.dont_write_bytecode = True
from smoke_test import Client, SmokeFailure, check, equal, checkpoint, path_id


class DockerRun:
    def __init__(self, image, timeout):
        self.image, self.timeout = image, timeout
        self.run_id = uuid.uuid4().hex
        self.label = 'com.sqlmanager.smoke.run'
        self.volume = 'sql-manager-smoke-' + self.run_id
        self.containers = []
        self.logs = {}
        self.volume_created = False

    def docker(self, *arguments, check_exit=True, timeout=30):
        result = subprocess.run(['docker', *arguments], text=True, capture_output=True, timeout=timeout)
        if check_exit and result.returncode:
            raise SmokeFailure(f'docker {" ".join(arguments)} failed ({result.returncode}):\n{result.stdout}{result.stderr}')
        return result

    def prepare(self):
        self.docker('info', '--format', '{{.ServerVersion}}')
        self.docker('image', 'inspect', self.image)
        check(self.docker('volume', 'inspect', self.volume, check_exit=False).returncode != 0,
              'Refusing to reuse a pre-existing volume')
        self.docker('volume', 'create', '--label', f'{self.label}={self.run_id}', self.volume)
        self.volume_created = True

    def owns_container(self, name):
        result = self.docker('inspect', name, check_exit=False)
        if result.returncode:
            return False
        inspected = json.loads(result.stdout)[0]
        return inspected.get('Config', {}).get('Labels', {}).get(self.label) == self.run_id

    def owns_volume(self):
        result = self.docker('volume', 'inspect', self.volume, check_exit=False)
        if result.returncode:
            return False
        return json.loads(result.stdout)[0].get('Labels', {}).get(self.label) == self.run_id

    def capture_log(self, name):
        if not self.owns_container(name):
            return
        result = self.docker('logs', name, check_exit=False)
        self.logs[name] = result.stdout + result.stderr

    def start(self, suffix):
        name = f'sql-manager-smoke-{self.run_id}-{suffix}'
        self.containers.append(name)
        self.docker('run', '--detach', '--pull', 'never', '--name', name,
                    '--label', f'{self.label}={self.run_id}',
                    '--mount', f'type=volume,source={self.volume},target=/data',
                    '--publish', '127.0.0.1::18080', self.image)
        ports = self.docker('port', name, '18080/tcp').stdout.strip().splitlines()
        equal(len(ports), 1, 'Container must publish exactly one loopback endpoint')
        check(ports[0].startswith('127.0.0.1:'), 'Docker smoke port must be bound to loopback only')
        client = Client('http://' + ports[0])
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            state = json.loads(self.docker('inspect', name).stdout)[0]['State']
            if not state.get('Running'):
                raise SmokeFailure(f'{name} stopped during startup (exit {state.get("ExitCode")}); see container logs.')
            try:
                status, _, body = client.request('GET', '/api/health', timeout=2)
                if status == 200:
                    equal(json.loads(body).get('status'), 'ok', 'Container health status must be ok')
                    client.refresh()
                    equal(client.state['settings']['dataDirectory'], '/data', 'Container must persist in the mounted /data directory')
                    return name, client
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.3)
        raise SmokeFailure(f'{name} was not healthy within {self.timeout:g}s')

    def remove_container(self, name):
        check(self.owns_container(name), f'Refusing to remove unowned container {name}')
        self.capture_log(name)
        self.docker('stop', '--time', '10', name, timeout=20)
        self.docker('rm', name)

    def cleanup(self):
        failures = []
        for name in reversed(self.containers):
            try:
                if self.owns_container(name):
                    self.capture_log(name)
                    self.docker('rm', '--force', name)
            except Exception as error:
                failures.append(str(error))
        if self.volume_created:
            try:
                check(self.owns_volume(), f'Refusing to remove unowned volume {self.volume}')
                self.docker('volume', 'rm', self.volume)
            except Exception as error:
                failures.append(str(error))
        return failures


def assert_packaged_ui(client):
    status, headers, body = client.request('GET', '/')
    equal(status, 200, 'Container must serve the packaged UI at /')
    content_type = next((value for key, value in headers.items() if key.lower() == 'content-type'), '')
    check('text/html' in content_type, 'UI root must be an HTML response')
    html = body.decode('utf-8')
    check('SQL Manager' in html and 'id="root"' in html, 'Root HTML must contain the SQL Manager application shell')
    assets = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html)
    check(assets, 'Packaged UI must reference a compiled JavaScript asset')
    for asset in assets:
        check(asset.startswith('/assets/') and not asset.endswith('.jsx'), 'UI must serve a production asset rather than source JSX')
        status, _, asset_body = client.request('GET', asset)
        equal(status, 200, 'Compiled UI JavaScript must be available')
        check(len(asset_body) > 100, 'Compiled UI JavaScript must not be empty')


def run_checks(run):
    run.prepare()
    first_name, client = run.start('first')
    check(all(not client.state[key] for key in ('scripts', 'releases', 'environments', 'packages')),
          'A fresh named volume must start with an empty workspace')
    assert_packaged_ui(client)
    checkpoint('Docker 镜像在随机本机端口启动，health 正常，/ 返回打包 UI 与可读 JS 资源')

    response = client.mutation('/api/environments', {'name': 'Docker 持久化验收', 'kind': '测试环境',
                              'codeVersion': 'v3.2.1', 'actualDb': 'docker_smoke', 'db': 'business'})
    environment_id = response['resultId']
    original = b'\xef\xbb\xbf' + '-- 中文 Docker 持久化验收\r\nCREATE TABLE docker_sample (id BIGINT PRIMARY KEY);\r\n'.encode('utf-8')
    script_id = client.upload('docker-baseline.sql', original, 'baseline', '中文 Docker 基线文件')
    before = copy.deepcopy(client.refresh())
    checkpoint('创建环境并上传 UTF-8 SQL，原文件字节和 SHA-256 已核对')

    run.remove_container(first_name)
    check(run.owns_volume(), 'Removing the first container must preserve its named volume')
    second_name, restored = run.start('second')
    check(second_name != first_name, 'Persistence must be tested with a newly created container')
    equal(restored.state, before, 'A new container using the same volume must preserve complete state and revision')
    environment = next((entry for entry in restored.state['environments'] if entry['id'] == environment_id), None)
    check(environment is not None, 'Environment record must survive container recreation')
    equal(environment['name'], 'Docker 持久化验收', 'Environment metadata must survive container recreation')
    status, _, downloaded = restored.request('GET', f'/api/scripts/{path_id(script_id)}/download')
    equal(status, 200, 'SQL original must download after container recreation')
    equal(downloaded, original, 'SQL bytes including BOM / CRLF / Chinese must survive container recreation')
    assert_packaged_ui(restored)
    checkpoint('移除容器后以同一 named volume 重建，环境、revision、SQL 原始字节及打包 UI 完整保留')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--image', default='sql-manager:1.0.0', help='Existing local image; no automatic pull or build')
    parser.add_argument('--timeout', type=float, default=75, help='Startup timeout per container in seconds')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    run = DockerRun(args.image, args.timeout)
    failure = None
    try:
        run_checks(run)
    except (Exception, KeyboardInterrupt):
        failure = traceback.format_exc()
    finally:
        cleanup_failures = run.cleanup()
        if cleanup_failures:
            failure = (failure or '') + '\nCleanup failures:\n' + '\n'.join(cleanup_failures)
    if failure:
        directory = Path(tempfile.mkdtemp(prefix='sql-manager-docker-smoke-failure-'))
        (directory / 'failure.txt').write_text(failure, encoding='utf-8')
        for name, log in run.logs.items():
            (directory / f'{name}.log').write_text(log, encoding='utf-8')
        print(f'DOCKER SMOKE TEST FAILED\n{failure}\nFailure logs: {directory}', file=sys.stderr)
        return 1
    checkpoint('已清理本次创建的两个专用容器和 named volume，未操作其他 Docker 资源')
    print('\nAll Docker smoke checks passed.', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
