import { useMemo, useRef, useState } from 'react';
import { IconDownload, IconPlus, IconClipboardCheck, IconFileCode, IconInfoCircle, IconAlertTriangle, IconCheck, IconHistory } from '@tabler/icons-react';
import { Badge, EmptyState, Modal, PageHeading, SearchInput, Select } from './ui.jsx';
import { localDateTime, formatDateTime } from './model.js';
import './delivery.css';

const packageStates = {
  completed: { label: '已登记成功', tone: 'success' },
  issue: { label: '待核实', tone: 'warning' },
  pending: { label: '待登记', tone: 'blue' },
  exported: { label: '待登记', tone: 'blue' },
  partial: { label: '部分已登记', tone: 'amber' },
};
const resultLabels = { notExecuted: '未执行', success: '完整成功', failed: '执行失败', partial: '部分执行／待核实' };
const hasRecord = pkg => (pkg.registrations || []).length > 0;
const isPending = pkg => !hasRecord(pkg) || ['pending', 'exported', 'partial'].includes(pkg.status);
const archivedScript = (pkg, scripts, id) => (pkg.files || []).find(item => item.id === id || item.scriptId === id) || scripts.find(item => item.id === id);
function inputTime(value) {
  if (!value) return '';
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : localDateTime(parsed);
  }
  return value.replace(' ', 'T').slice(0, 16);
}

export function DeliveriesPage({ packages, environments, scripts, onRegister, onDownload, onNew }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [downloading, setDownloading] = useState(null);
  const [error, setError] = useState('');
  const downloadingRef = useRef(false);
  const visible = useMemo(() => packages.filter(pkg => {
    const state = packageStates[pkg.status] || packageStates.pending;
    const matchesStatus = filter === 'all' || (filter === 'pending' ? isPending(pkg) : pkg.status === filter);
    return matchesStatus && `${pkg.id} ${pkg.envName} ${pkg.target} ${state.label}`.toLowerCase().includes(query.trim().toLowerCase());
  }), [packages, query, filter]);
  const pending = packages.filter(isPending).length;
  async function download(pkg) {
    if (downloadingRef.current) return;
    downloadingRef.current = true; setDownloading(pkg.id); setError('');
    try { await onDownload(pkg); }
    catch (err) { setError(err.message || '下载交付包失败，请重试。'); }
    finally { downloadingRef.current = false; setDownloading(null); }
  }
  return <section className="delivery-page">
    <PageHeading title="交付包" subtitle="查看已导出的脚本，登记现场执行结果。"><button className="button primary" onClick={onNew}><IconPlus size={18}/>新建交付包</button></PageHeading>
    <div className="toolbar delivery-toolbar"><SearchInput value={query} onChange={setQuery} placeholder="搜索交付包、环境或版本"/><div className="delivery-filters" role="group" aria-label="按登记状态筛选">{[['all', '全部交付包'], ['pending', '待登记'], ['issue', '待核实'], ['completed', '已完成']].map(([value, label]) => <button key={value} className={`delivery-filter ${filter === value ? 'active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{value === 'pending' && pending > 0 && <span className="delivery-count">{pending}</span>}</button>)}</div></div>
    <div className="delivery-notice"><IconInfoCircle size={18}/><span>交付包生成后不会更新环境状态，请在现场执行后登记结果。</span></div>
    {error && <p className="result-error" role="alert">{error}</p>}
    {visible.length ? <div className="delivery-table-scroll"><table className="data-table delivery-table"><thead><tr><th>交付包</th><th>目标环境</th><th>目标版本</th><th>登记状态</th><th>操作</th></tr></thead><tbody>{visible.map(pkg => {
      const state = packageStates[pkg.status] || packageStates.pending;
      const environment = environments.find(item => item.id === pkg.envId);
      return <tr key={pkg.id}>
        <td><span className="delivery-package-id">{pkg.id}</span><span className="delivery-secondary">{formatDateTime(pkg.createdAt)} · {pkg.scriptIds.length} 个脚本</span></td>
        <td><span className="delivery-primary-text">{pkg.envName || environment?.name}</span><span className="delivery-secondary">{pkg.db || environment?.db || 'business'}</span></td>
        <td><span className="delivery-version">{pkg.target}</span><span className="delivery-secondary">{pkg.type === 'install' ? '首次安装' : '增量升级'}</span></td>
        <td><Badge tone={state.tone}>{state.label}</Badge>{hasRecord(pkg) && <span className="delivery-secondary">{pkg.registrations.length} 次登记</span>}</td>
        <td><div className="delivery-actions"><button className="text-button" disabled={downloading !== null} onClick={() => download(pkg)} aria-label={`下载 ${pkg.id}`}><IconDownload size={17}/>{downloading === pkg.id ? '下载中…' : '下载'}</button><button className="text-button" onClick={() => onRegister(pkg)} aria-label={`${hasRecord(pkg) ? '修正登记' : '登记结果'} ${pkg.id}`}><IconClipboardCheck size={17}/>{hasRecord(pkg) ? '修正登记' : '登记结果'}</button></div></td>
      </tr>;
    })}</tbody></table></div> : <EmptyState title={query || filter !== 'all' ? '没有匹配的交付包' : '还没有交付包'} description={query || filter !== 'all' ? '试试其他关键词或登记状态。' : '选择环境和目标版本，预览后生成第一个交付包。'}>{query || filter !== 'all' ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button> : <button className="button primary" onClick={onNew}>新建交付包</button>}</EmptyState>}
    <div className="delivery-list-footer">共 {visible.length} 个交付包<span>同一交付包的登记修正会保留原记录。</span></div>
  </section>;
}

function RegistrationHistory({ pkg, scripts }) {
  const registrations = pkg.registrations || [];
  if (!registrations.length) return null;
  return <details className="result-history"><summary><IconHistory size={18}/><span>历次登记</span><span className="result-history-count">{registrations.length} 条</span></summary><div className="result-history-list">{registrations.map((record, index) => <article className="result-history-entry" key={record.id || index}>
    <header><strong>{index === 0 ? '首次登记' : `第 ${index} 次修正`}</strong><span>登记于 {formatDateTime(record.recordedAt || record.createdAt)}</span></header>
    <p className="result-history-meta">执行人：{record.operator || '—'}<span>实际执行时间：{formatDateTime(record.executedAt)}</span></p>
    <ul>{pkg.scriptIds.map(id => { const script = archivedScript(pkg, scripts, id); const value = record.results?.[id] || 'notExecuted'; return <li key={id}><span title={script?.name || id}>{id} · {script?.description || script?.name || 'SQL 文件'}</span><Badge tone={value === 'success' ? 'success' : ['failed', 'partial'].includes(value) ? 'warning' : 'neutral'}>{resultLabels[value] || value}</Badge></li>; })}</ul>
    {record.note && <p className="result-history-note">{index === 0 ? '备注' : '修正原因'}：{record.note}</p>}
  </article>)}</div></details>;
}

export function ResultDialog({ pkg, scripts, environment, onSave, onClose }) {
  const correcting = hasRecord(pkg);
  const submitting = useRef(false);
  const [results, setResults] = useState(() => Object.fromEntries(pkg.scriptIds.map(id => [id, correcting ? pkg.results?.[id] || 'notExecuted' : 'notExecuted'])));
  const [operator, setOperator] = useState('');
  const [executedAt, setExecutedAt] = useState(inputTime(pkg.executedAt));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formId = `result-form-${pkg.id}`;
  const hasIssue = Object.values(results).some(value => value === 'failed' || value === 'partial');
  const successCount = Object.values(results).filter(value => value === 'success').length;
  const allUnexecuted = Object.values(results).every(value => value === 'notExecuted');
  const latestRegistration = (pkg.registrations || []).at(-1);
  const changeResult = (id, value) => { setResults(previous => ({ ...previous, [id]: value })); setError(''); };
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (!correcting && allUnexecuted) return setError('请至少登记一个文件的实际执行结果。');
    if (!operator.trim()) return setError('请填写现场执行人。');
    if (!executedAt) return setError('请选择实际执行时间。');
    if (executedAt > localDateTime()) return setError('实际执行时间不能晚于当前时间。');
    if ((hasIssue || correcting) && !note.trim()) return setError(correcting ? '请填写本次修正原因，原登记记录会保留。' : '请说明失败或部分执行的情况，便于后续核实。');
    submitting.current = true; setBusy(true); setError('');
    try { await onSave({ results, operator: operator.trim(), executedAt, note: note.trim() }); }
    catch (err) { setError(err.message || '保存失败，请重试。'); }
    finally { submitting.current = false; setBusy(false); }
  }
  const close = () => { if (!submitting.current) onClose(); };
  return <Modal wide title={correcting ? '修正执行登记' : '登记执行结果'} description="依据现场实际结果登记；此操作不会执行任何 SQL。" onClose={close} footer={<>
    <span className="result-footer-summary">已选完整成功 <strong>{successCount}</strong> / {pkg.scriptIds.length} 个文件</span>
    <button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button>
    <button type="submit" form={formId} className="button primary" disabled={busy}>{busy ? '正在保存…' : correcting ? '保存修正' : '确认登记'}</button>
  </>}>
    <form id={formId} className="result-form" onSubmit={submit}>
      <div className="result-context"><div><span className="result-context-label">目标环境</span><strong>{pkg.envName || environment?.name}</strong></div><div><span className="result-context-label">目标数据库</span><strong>{pkg.actualDb || pkg.environmentSnapshot?.actualDb || environment?.actualDb || pkg.db}</strong><small>{pkg.db || environment?.db}</small></div><div><span className="result-context-label">目标版本</span><strong className="result-mono">{pkg.target}</strong></div></div>
      <p className="result-package-ref">交付包 <span>{pkg.id}</span></p>
      {correcting && <div className="result-correction-note"><IconInfoCircle size={18}/><div>此次操作会追加修正记录，保留原登记。{(pkg.note || latestRegistration?.note) && <p>上次备注：{pkg.note || latestRegistration.note}</p>}</div></div>}
      <div className="result-section-heading"><h3>逐文件确认结果</h3><button type="button" disabled={busy} className="text-button" onClick={() => { setResults(Object.fromEntries(pkg.scriptIds.map(id => [id, 'success']))); setError(''); }}><IconCheck size={17}/>全部标记成功</button></div>
      <div className="result-file-list">{pkg.scriptIds.map((id, index) => {
        const script = archivedScript(pkg, scripts, id);
        return <div className="result-file-row" key={id}><span className="result-file-index">{String(index + 1).padStart(2, '0')}</span><IconFileCode className="result-file-icon" size={21} stroke={1.5}/><div className="result-file-name"><strong>{script?.name || id}</strong><span>{script?.description || '已归档 SQL 文件'}</span></div><Select disabled={busy} aria-label={`${id} 执行结果`} value={results[id]} onChange={event => changeResult(id, event.target.value)}>{Object.entries(resultLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>;
      })}</div>
      {hasIssue && <div className="result-warning"><IconAlertTriangle size={19}/><span>部分语句可能已生效。该环境将标记为待核实，核实前不生成后续升级包。</span></div>}
      {correcting && allUnexecuted && <div className="result-correction-note"><IconInfoCircle size={18}/><span>本次将该包的执行结果修正为全部未执行。请说明撤回依据，原记录仍会保留。</span></div>}
      <div className="result-form-grid"><label className="field"><span>现场执行人 <span className="result-required">*</span></span><input required disabled={busy} maxLength={60} value={operator} onChange={e => setOperator(e.target.value)} placeholder="填写执行人姓名"/></label><label className="field"><span>实际执行时间 <span className="result-required">*</span></span><input required disabled={busy} type="datetime-local" max={localDateTime()} value={executedAt} onChange={e => setExecutedAt(e.target.value)}/></label></div>
      <label className="field"><span>{correcting ? '修正原因' : '执行备注'}{(hasIssue || correcting) && <span className="result-required"> *</span>}</span><textarea rows={3} disabled={busy} required={hasIssue || correcting} maxLength={1500} value={note} onChange={e => { setNote(e.target.value); setError(''); }} placeholder={correcting ? '说明核实情况和此次修正的依据' : hasIssue ? '说明失败位置、已执行部分和待核实事项' : '可填写现场核对情况或其他说明'}/></label>
      {error && <p className="result-error" role="alert">{error}</p>}
      <RegistrationHistory pkg={pkg} scripts={scripts}/>
    </form>
  </Modal>;
}
