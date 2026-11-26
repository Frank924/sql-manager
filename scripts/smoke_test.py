#!/usr/bin/env python3
"""Exercise the packaged application using isolated, temporary workspaces.

Usage: python3 scripts/smoke_test.py [--jar backend/target/sql-manager-1.0.0.jar]
Requires only Python's standard library and Java 17+. Never uses project data/.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile


class SmokeFailure(RuntimeError):
    pass


def check(condition, message):
    if not condition:
        raise SmokeFailure(message)


def equal(actual, expected, message):
    if actual != expected:
        raise SmokeFailure(f"{message}\nExpected: {expected!r}\nActual:   {actual!r}")


def checkpoint(message):
    print(f"PASS  {message}", flush=True)


def item(state, collection, identifier):
    found = next((entry for entry in state[collection] if entry['id'] == identifier), None)
    check(found is not None, f"Missing {collection} item {identifier}")
    return found


def path_id(value):
    return urllib.parse.quote(str(value), safe='')


def multipart(fields, filename, content, content_type='application/octet-stream'):
    boundary = 'sql-manager-smoke-' + uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.extend([
            f'--{boundary}\r\n'.encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode('utf-8'), b'\r\n',
        ])
    chunks.extend([
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode('utf-8'),
        f'Content-Type: {content_type}\r\n\r\n'.encode(),
        content, b'\r\n', f'--{boundary}--\r\n'.encode(),
    ])
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


class Server:
    def __init__(self, java, jar, root, name, timeout):
        self.java, self.jar, self.root, self.name, self.timeout = java, jar, root, name, timeout
        self.data = root / f'{name}-data'
        self.process = None
        self.log = None
        self.logs = []
        self.starts = 0

    def start(self):
        self.starts += 1
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1', 0))
            port = port_socket.getsockname()[1]
        self.base = f'http://127.0.0.1:{port}'
        log_path = self.root / f'{self.name}-{self.starts}.log'
        self.logs.append(log_path)
        self.log = log_path.open('wb')
        command = [self.java, '-jar', str(self.jar), '--server.address=127.0.0.1',
                   f'--server.port={port}', f'--sqlmanager.data-dir={self.data}']
        environment = os.environ.copy()
        environment.update({'DATA_DIR': str(self.data), 'PORT': str(port), 'SERVER_ADDRESS': '127.0.0.1'})
        self.process = subprocess.Popen(command, cwd=self.root, env=environment,
                                        stdout=self.log, stderr=subprocess.STDOUT)
        client = Client(self.base)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SmokeFailure(f'{self.name} exited during startup (code {self.process.returncode}); see server logs.')
            try:
                status, _, _ = client.request('GET', '/api/health', timeout=2)
                if status == 200:
                    client.refresh()
                    equal(Path(client.state['settings']['dataDirectory']).resolve(), self.data.resolve(),
                          f'{self.name} must use only its temporary data directory')
                    return client
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.25)
        raise SmokeFailure(f'{self.name} did not become healthy within {self.timeout:g}s; see server logs.')

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log is not None:
            self.log.close()
            self.log = None


class Client:
    def __init__(self, base):
        self.base = base
        self.state = None
        # Proxy environment variables must never route this local test elsewhere.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, path, body=None, headers=None, timeout=20):
        request = urllib.request.Request(self.base + path, data=body, method=method,
                                         headers=headers or {})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as response:
            return response.code, dict(response.headers), response.read()

    def refresh(self):
        status, _, body = self.request('GET', '/api/state')
        equal(status, 200, 'GET /api/state must succeed')
        self.state = json.loads(body)
        for key in ('scripts', 'releases', 'environments', 'packages'):
            check(isinstance(self.state.get(key), list), f'State.{key} must be an array')
        check(isinstance(self.state.get('revision'), int), 'State.revision must be an integer')
        return self.state

    def mutation(self, path, values=None, *, method='POST', raw=None, content_type=None,
                 expect=(200, 201), revision=None):
        if revision is None:
            revision = self.state['revision']
        headers = {'If-Match': str(revision)}
        if raw is None:
            raw = json.dumps(values if values is not None else {}, ensure_ascii=False).encode('utf-8')
            content_type = 'application/json'
        headers['Content-Type'] = content_type or 'application/octet-stream'
        before = copy.deepcopy(self.state)
        status, _, body = self.request(method, path, raw, headers)
        permitted = (expect,) if isinstance(expect, int) else expect
        check(status in permitted, f'{method} {path}: expected HTTP {permitted}, got {status}: {body[:1200].decode("utf-8", "replace")}')
        try:
            response = json.loads(body)
        except (ValueError, UnicodeDecodeError) as error:
            raise SmokeFailure(f'{method} {path} must return JSON: {error}') from error
        if status >= 400:
            check(isinstance(response.get('message'), str) and response['message'].strip(), 'API error must include a readable message')
            check('trace' not in response and 'stackTrace' not in response, 'API error must not leak stack traces')
            current = self.refresh()
            equal(current, before, f'Rejected {method} {path} must not change workspace state')
        else:
            check('state' in response and 'resultId' in response, 'Mutation must return {state,resultId}')
            self.state = response['state']
            check(self.state['revision'] > before['revision'], 'Successful mutation must advance revision')
        return response

    def upload(self, filename, content, kind, description):
        body, content_type = multipart({'description': description, 'db': 'business', 'type': kind}, filename, content, 'application/sql')
        response = self.mutation('/api/scripts', raw=body, content_type=content_type)
        identifier = response['resultId']
        script = item(self.state, 'scripts', identifier)
        equal(script['hash'], hashlib.sha256(content).hexdigest(), 'Stored SHA-256 must cover exact uploaded bytes')
        equal(script['size'], len(content), 'Stored size must include BOM and CRLF bytes')
        check('content' not in script, 'State must not embed SQL source contents')
        status, _, original = self.request('GET', f'/api/scripts/{path_id(identifier)}/download')
        equal(status, 200, 'Original SQL download must succeed')
        equal(original, content, 'Original SQL download must preserve bytes')
        status, _, preview = self.request('GET', f'/api/scripts/{path_id(identifier)}/content')
        equal(status, 200, 'SQL preview must succeed')
        check('中文' in preview.decode('utf-8-sig'), 'Preview must preserve Chinese text')
        return identifier

    def publish(self, version, baseline, script_ids, previous):
        self.mutation('/api/releases', {'id': version, 'name': '验收发布 ' + version,
                                      'baseline': baseline, 'scriptIds': script_ids,
                                      'previous': previous, 'notes': '自动验收使用的隔离测试数据'})
        self.mutation(f'/api/releases/{path_id(version)}/publish', {})
        release = item(self.state, 'releases', version)
        equal(release['status'], 'published', 'Release must be published')
        equal(release['scriptIds'], script_ids, 'Published manifest must preserve explicit order')
        for identifier in script_ids:
            check(item(self.state, 'scripts', identifier)['frozen'], 'Published SQL must be frozen')


def assert_zip(client, package_id, expected_files):
    before = copy.deepcopy(client.state)
    package = item(client.state, 'packages', package_id)
    status, _, body = client.request('GET', f'/api/packages/{path_id(package_id)}/download')
    equal(status, 200, 'Delivery ZIP download must succeed')
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        names = archive.namelist()
        check('manifest.json' in names, 'ZIP must contain manifest.json')
        manifest = json.loads(archive.read('manifest.json'))
        manifest_files = manifest.get('scripts', manifest.get('files'))
        check(isinstance(manifest_files, list), 'Manifest must contain an ordered scripts/files list')
        equal([entry['id'] for entry in manifest_files], package['scriptIds'], 'ZIP manifest order must match immutable package')
        equal(manifest.get('actualDatabase'), package['actualDb'], 'ZIP must identify actual target database')
        equal(manifest.get('inputApplied'), package['inputApplied'], 'ZIP must retain the original applied snapshot')
        sql_names = [name for name in names if name.lower().endswith('.sql')]
        equal(len(sql_names), len(package['scriptIds']), 'ZIP must contain exactly the required SQL files')
        for index, entry in enumerate(manifest_files, 1):
            raw = expected_files[entry['id']]
            archive_name = entry.get('file', entry.get('path'))
            check(isinstance(archive_name, str) and archive_name in names, 'Manifest must point to a ZIP entry')
            equal(archive.read(archive_name), raw, 'ZIP SQL must preserve original BOM, CRLF and UTF-8 bytes')
            equal(entry.get('sha256', entry.get('hash')), hashlib.sha256(raw).hexdigest(), 'ZIP manifest SHA-256 must match original bytes')
            if 'order' in entry:
                equal(entry['order'], index, 'ZIP ordering must be sequential')
        check(any(name.lower().endswith('.csv') for name in names), 'ZIP must include a result registration CSV')
        check(any(name.lower().endswith(('.txt', '.md')) for name in names), 'ZIP must include execution instructions')
    equal(client.refresh(), before, 'ZIP download must not mutate state')
    return body


def run_checks(source, restore_server):
    client = source.start()
    check(all(not client.state[key] for key in ('scripts', 'releases', 'environments', 'packages')), 'New service must start empty')
    checkpoint('空工作区启动，数据目录位于 TemporaryDirectory')

    before_guards = copy.deepcopy(client.state)
    foreign_payload = json.dumps({'name': '外部来源不应创建', 'kind': '独立部署', 'codeVersion': '',
                                  'actualDb': 'smoke_rejected', 'db': 'business'}).encode()
    status, _, error_body = client.request('POST', '/api/environments', foreign_payload,
        {'Content-Type': 'application/json', 'If-Match': str(client.state['revision']),
         'Origin': 'https://untrusted.example'})
    equal(status, 403, 'Foreign-Origin writes must be rejected')
    check(json.loads(error_body).get('message'), 'Foreign-Origin rejection must return a readable message')
    equal(client.refresh(), before_guards, 'Foreign-Origin rejection must leave the workspace unchanged')
    status, _, error_body = client.request('GET', '/api/state', headers={'Host': 'untrusted.example'})
    equal(status, 403, 'A malicious Host must not expose local workspace data')
    check(json.loads(error_body).get('message'), 'Host rejection must return a readable message')
    equal(client.refresh(), before_guards, 'Host rejection must leave the workspace unchanged')
    checkpoint('Foreign Origin 写入及恶意 Host 读取均返回 403，不改变工作区')

    baseline_bytes = b'\xef\xbb\xbf' + '-- 中文初始基线\r\nCREATE TABLE sample (id BIGINT PRIMARY KEY);\r\n'.encode('utf-8')
    baseline = client.upload('baseline.sql', baseline_bytes, 'baseline', '中文初始基线')
    originals = {baseline: baseline_bytes}
    client.publish('v2.7.3', baseline, [baseline], None)
    checkpoint('BOM / CRLF / 中文 SQL 原字节保存，任意首版本 v2.7.3 发布')

    response = client.mutation('/api/environments', {'name': '存量环境验收', 'kind': '独立部署', 'codeVersion': 'v2.7.3', 'actualDb': 'smoke_existing', 'db': 'business'})
    environment_id = response['resultId']
    client.mutation(f'/api/environments/{path_id(environment_id)}/baseline', {'version': 'v2.7.3', 'operator': '验收人员', 'note': '已核实现场结构及公共数据', 'confirmed': True})
    environment = item(client.state, 'environments', environment_id)
    equal(environment['applied'], [baseline], 'Baseline takeover must record confirmed coverage')
    equal(environment['baseline'], baseline, 'Takeover must identify the chosen baseline')
    check(environment['history'], 'Takeover must retain a confirmation event')
    check(not client.state['packages'], 'Takeover must not fabricate an executed delivery package')
    checkpoint('存量环境确认基线，保留确认记录而不伪造交付执行')

    first_bytes = '-- 中文增量一\r\nALTER TABLE sample ADD COLUMN note VARCHAR(128);\r\n'.encode('utf-8')
    second_bytes = b'\xef\xbb\xbf' + '-- 中文增量二\r\nALTER TABLE sample ADD COLUMN returned_at TIMESTAMP;\r\n'.encode('utf-8')
    first = client.upload('increment-one.sql', first_bytes, 'increment', '中文增量一')
    second = client.upload('increment-two.sql', second_bytes, 'increment', '中文增量二')
    originals.update({first: first_bytes, second: second_bytes})
    client.publish('v2.8.0', baseline, [first], 'v2.7.3')
    client.publish('v2.9.0', baseline, [second], 'v2.8.0')
    before_environment = copy.deepcopy(item(client.state, 'environments', environment_id))
    response = client.mutation('/api/packages', {'envId': environment_id, 'target': 'v2.9.0', 'type': 'upgrade', 'confirmedEmpty': False})
    package_id = response['resultId']
    package = item(client.state, 'packages', package_id)
    equal(package['scriptIds'], [first, second], 'Cross-version upgrade must include only ordered pending increments')
    equal(item(client.state, 'environments', environment_id), before_environment, 'Export must not update any environment ledger field')
    assert_zip(client, package_id, originals)
    checkpoint('跨版本升级 ZIP 清单、执行顺序、原始字节与 SHA-256 一致；导出不改台账')

    response = client.mutation('/api/environments', {'name': '空库安装验收', 'kind': '独立部署', 'codeVersion': '', 'actualDb': 'smoke_fresh', 'db': 'business'})
    fresh_environment = response['resultId']
    fresh_before = copy.deepcopy(item(client.state, 'environments', fresh_environment))
    client.mutation('/api/packages', {'envId': fresh_environment, 'target': 'v2.9.0', 'type': 'install', 'confirmedEmpty': False}, expect=400)
    response = client.mutation('/api/packages', {'envId': fresh_environment, 'target': 'v2.9.0', 'type': 'install', 'confirmedEmpty': True})
    install_id = response['resultId']
    equal(item(client.state, 'packages', install_id)['scriptIds'], [baseline, first, second], 'Fresh install must include baseline plus ordered increments')
    equal(item(client.state, 'environments', fresh_environment), fresh_before, 'First-install export must not register execution')
    assert_zip(client, install_id, originals)
    checkpoint('空库安装须主动确认，ZIP 包含基线与累计增量')

    execution_time = dt.datetime.now().strftime('%Y-%m-%dT%H:%M')
    mixed_results = {first: 'success', second: 'partial'}
    client.mutation(f'/api/packages/{path_id(package_id)}/results', {'results': mixed_results, 'operator': '验收人员', 'executedAt': execution_time, 'note': '第二个文件执行到一半，等待核实'})
    environment = item(client.state, 'environments', environment_id)
    equal(set(environment['applied']), {baseline, first}, 'Only fully successful scripts may become applied')
    check(second in environment['issues'], 'Partial execution must remain an unresolved issue')
    equal(environment['codeVersion'], 'v2.7.3', 'SQL result registration must not advance code version')
    client.mutation('/api/packages', {'envId': environment_id, 'target': 'v2.9.0', 'type': 'upgrade', 'confirmedEmpty': False}, expect=409)
    checkpoint('部分执行记录阻止后续导出，已成功文件保留，代码版本独立')

    success_results = {first: 'success', second: 'success'}
    client.mutation(f'/api/packages/{path_id(package_id)}/results', {'results': success_results, 'operator': '验收人员', 'executedAt': execution_time, 'note': ''}, expect=400)
    client.mutation(f'/api/packages/{path_id(package_id)}/results', {'results': success_results, 'operator': '核实人员', 'executedAt': execution_time, 'note': '核实后补齐剩余语句，修正为完整成功'})
    package = item(client.state, 'packages', package_id)
    equal(len(package['registrations']), 2, 'Corrections must append an audit record')
    equal(package['registrations'][0]['results'], mixed_results, 'Original partial result must remain in audit history')
    equal(package['registrations'][1]['results'], success_results, 'Latest corrected result must be retained')
    check(all(record.get('recordedAt') for record in package['registrations']), 'Each registration must have a server recording timestamp')
    environment = item(client.state, 'environments', environment_id)
    equal(set(environment['applied']), {baseline, first, second}, 'Correction must update applied coverage')
    equal(environment['issues'], [], 'Correcting the original issue must clear it')
    equal(environment['codeVersion'], 'v2.7.3', 'Correction must leave code version unchanged')
    checkpoint('更正必须填写原因，原结果和新结果均保留审计时间')

    client.mutation(f'/api/packages/{path_id(package_id)}/results', {'results': {first: 'success', second: 'success', 'NOT-IN-PACKAGE': 'success'}, 'operator': '验收人员', 'executedAt': execution_time, 'note': '无效外部脚本'}, expect=400)
    client.mutation(f'/api/packages/{path_id(package_id)}/results', {'results': {first: 'success'}, 'operator': '验收人员', 'executedAt': execution_time, 'note': '缺失清单项'}, expect=400)
    client.mutation('/api/environments', raw=b'{"name":', content_type='application/json', expect=400)
    client.mutation(f'/api/environments/{path_id(environment_id)}', {'name': '非法台账改写', 'kind': '独立部署', 'codeVersion': 'v2.7.3', 'actualDb': 'smoke_existing', 'db': 'business', 'applied': []}, method='PUT', expect=400)
    checkpoint('错误脚本编号、遗漏结果、非法 JSON 和越权台账字段均被拒绝且无写入')

    stale_revision = client.state['revision']
    metadata = {'name': '存量环境验收-已更新', 'kind': '独立部署', 'codeVersion': 'v2.7.3', 'actualDb': 'smoke_existing', 'db': 'business'}
    client.mutation(f'/api/environments/{path_id(environment_id)}', metadata, method='PUT')
    client.mutation(f'/api/environments/{path_id(environment_id)}', {**metadata, 'name': '过期请求不应写入'}, method='PUT', revision=stale_revision, expect=409)
    checkpoint('过期 If-Match 返回 409，不覆盖已保存的数据')

    client.publish('v2.9.1', baseline, [], 'v2.9.0')
    equal(item(client.state, 'releases', 'v2.9.1')['scriptIds'], [], 'Code-only release must keep an empty incremental manifest')
    checkpoint('无 SQL 变更的代码发布可正常发布')

    before_restart = copy.deepcopy(client.refresh())
    source.stop()
    client = source.start()
    equal(client.state, before_restart, 'Restart must preserve the entire workspace state and revision')
    for identifier, content in originals.items():
        status, _, downloaded = client.request('GET', f'/api/scripts/{path_id(identifier)}/download')
        equal(status, 200, 'Persisted SQL must be downloadable after restart')
        equal(downloaded, content, 'Restart must preserve original SQL bytes')
    assert_zip(client, package_id, originals)
    checkpoint('进程重启后状态、台账、发布及 SQL 原文件保持一致')

    before_backup = copy.deepcopy(client.state)
    status, _, backup = client.request('GET', '/api/backup')
    equal(status, 200, 'Full backup must download successfully')
    check(zipfile.is_zipfile(io.BytesIO(backup)), 'Backup must be a ZIP archive')
    equal(client.refresh(), before_backup, 'Backup must not mutate the workspace')
    restore_body, restore_type = multipart({'confirmed': 'true'}, 'backup.zip', backup, 'application/zip')
    client.mutation('/api/restore', raw=restore_body, content_type=restore_type, expect=409)
    checkpoint('一致性备份可下载，已有数据的工作区拒绝恢复')

    restored = restore_server.start()
    check(all(not restored.state[key] for key in ('scripts', 'releases', 'environments', 'packages')), 'Restore destination must start empty')
    bad_body, bad_type = multipart({'confirmed': 'true'}, 'invalid.zip', b'not a zip', 'application/zip')
    restored.mutation('/api/restore', raw=bad_body, content_type=bad_type, expect=400)
    restored.mutation('/api/restore', raw=restore_body, content_type=restore_type)
    for collection in ('scripts', 'releases', 'environments', 'packages'):
        equal(restored.state[collection], before_backup[collection], f'Restored {collection} must match the backup')
    equal(Path(restored.state['settings']['dataDirectory']).resolve(), restore_server.data.resolve(), 'Restore must keep destination data directory')
    for identifier, content in originals.items():
        status, _, downloaded = restored.request('GET', f'/api/scripts/{path_id(identifier)}/download')
        equal(status, 200, 'Restored SQL must be downloadable')
        equal(downloaded, content, 'Restored SQL must preserve original bytes')
    assert_zip(restored, package_id, originals)
    restored.mutation('/api/restore', raw=restore_body, content_type=restore_type, expect=409)
    checkpoint('另一空实例恢复成功，文件和审计记录一致，重复恢复被拒绝')

    before_concurrent = copy.deepcopy(client.refresh())
    barrier = threading.Barrier(2)
    def concurrent_write(suffix):
        payload = json.dumps({'name': '并发验收-' + suffix, 'kind': '测试环境', 'codeVersion': '',
                              'actualDb': 'smoke_concurrent_' + suffix.lower(), 'db': 'business'},
                             ensure_ascii=False).encode('utf-8')
        other = Client(client.base)
        barrier.wait(timeout=10)
        return other.request('POST', '/api/environments', payload,
                             {'Content-Type': 'application/json', 'If-Match': str(before_concurrent['revision'])})
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(concurrent_write, ('A', 'B')))
    statuses = [response[0] for response in responses]
    equal(sum(status in (200, 201) for status in statuses), 1, 'Exactly one simultaneous write may succeed')
    equal(statuses.count(409), 1, 'The other simultaneous write must fail with HTTP 409')
    after_concurrent = client.refresh()
    equal(after_concurrent['revision'], before_concurrent['revision'] + 1, 'Concurrent writes must commit exactly once')
    equal(len(after_concurrent['environments']), len(before_concurrent['environments']) + 1,
          'Concurrent writes must create exactly one environment')
    created = [env for env in after_concurrent['environments'] if env['name'] in ('并发验收-A', '并发验收-B')]
    equal(len(created), 1, 'The rejected concurrent write must not leak an environment')
    checkpoint('同一 revision 的并发写入仅一个成功，另一个返回 409，只有一次持久化提交')


def main():
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--jar', type=Path, default=repository / 'backend/target/sql-manager-1.0.0.jar', help='Packaged Spring Boot JAR')
    parser.add_argument('--java', default=str(Path(os.environ['JAVA_HOME']) / 'bin/java') if os.environ.get('JAVA_HOME') else 'java', help='Java 17+ executable')
    parser.add_argument('--timeout', type=float, default=60, help='Startup timeout per process in seconds (default: 60)')
    args = parser.parse_args()
    jar = args.jar.expanduser().resolve()
    if not jar.is_file():
        parser.error(f'JAR does not exist: {jar}; build the application first.')
    if args.timeout <= 0:
        parser.error('--timeout must be positive')

    failure = None
    servers = []
    with tempfile.TemporaryDirectory(prefix='sql-manager-smoke-') as temporary:
        root = Path(temporary)
        source = Server(args.java, jar, root, 'source', args.timeout)
        restore = Server(args.java, jar, root, 'restore', args.timeout)
        servers.extend([source, restore])
        try:
            run_checks(source, restore)
            print('\nAll smoke checks passed. No project data directory was used.', flush=True)
        except (Exception, KeyboardInterrupt):
            failure = traceback.format_exc()
        finally:
            for server in reversed(servers):
                server.stop()
            if failure:
                # Preserve only readable diagnostics; temporary workspaces are always deleted.
                failure_dir = Path(tempfile.mkdtemp(prefix='sql-manager-smoke-failure-'))
                (failure_dir / 'failure.txt').write_text(failure, encoding='utf-8')
                print(f'\nSMOKE TEST FAILED\n{failure}', file=sys.stderr)
                for server in servers:
                    for log_path in server.logs:
                        if log_path.exists():
                            shutil.copy2(log_path, failure_dir / log_path.name)
                            tail = '\n'.join(log_path.read_text(encoding='utf-8', errors='replace').splitlines()[-45:])
                            print(f'\n--- {log_path.name} (last 45 lines) ---\n{tail}', file=sys.stderr)
                print(f'\nFailure logs retained at: {failure_dir}', file=sys.stderr)
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(main())
