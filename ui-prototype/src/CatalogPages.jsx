import { useEffect, useRef, useState } from 'react';
import { IconUpload, IconPlus, IconFileText, IconFileTypeSql, IconLock, IconArrowUp, IconArrowDown, IconInfoCircle, IconDownload, IconCheck, IconX } from '@tabler/icons-react';
import { Badge, PageHeading, SearchInput, Select, EmptyState, Modal } from './ui.jsx';
import { requiredScriptIds, formatDateTime } from './model.js';
import { apiText, downloadApi } from './api.js';
import './catalog.css';

const dateLabel = value => value ? formatDateTime(value).slice(0, 10) : '—';

export function ScriptPreview({ script, releases, onClose }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setContent('');
    apiText(`/api/scripts/${encodeURIComponent(script.id)}/content`)
      .then(value => { if (active) setContent(value); })
      .catch(err => { if (active) setError(err.message || '读取 SQL 文件失败，请重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [script.id, reload]);
  async function download() {
    if (downloadBusy) return;
    setDownloadBusy(true); setError('');
    try { await downloadApi(`/api/scripts/${encodeURIComponent(script.id)}/download`, script.name); }
    catch (err) { setError(err.message || '下载失败，请重试。'); }
    finally { setDownloadBusy(false); }
  }
  const linked = (releases || []).filter(r => r.scriptIds.includes(script.id));
  return <Modal wide title="SQL 文件详情" description="查看原始内容、校验值与所属发布。" onClose={onClose} footer={<>
    <button className="button secondary" onClick={onClose}>关闭</button>
    <button className="button primary" disabled={downloadBusy} onClick={download}><IconDownload size={18}/>{downloadBusy ? '正在下载…' : '下载原文件'}</button>
  </>}>
    <div className="catalog-preview-title"><IconFileTypeSql size={32} stroke={1.4}/><div><h3>{script.name}</h3><p>{script.description}</p></div><Badge tone={script.frozen ? 'neutral' : 'blue'}>{script.frozen ? '已冻结' : '待发布'}</Badge></div>
    <dl className="catalog-file-meta"><div><dt>脚本编号</dt><dd>{script.id}</dd></div><div><dt>目标库</dt><dd>{script.db}</dd></div><div><dt>文件类型</dt><dd>{script.type === 'baseline' ? '安装基线' : '增量脚本'}</dd></div><div><dt>上传日期</dt><dd>{dateLabel(script.createdAt)}</dd></div></dl>
    {script.frozen && <div className="catalog-info"><IconLock size={18}/><span>此脚本已冻结，后续修正请上传新的 SQL 文件。</span></div>}
    <div className="catalog-code-caption"><span>原始 SQL</span><span>UTF-8 · {Number(script.size || 0).toLocaleString()} B</span></div>
    {loading ? <div className="catalog-code catalog-loading" role="status">正在读取 SQL 内容…</div> : content ? <pre className="catalog-code"><code>{content}</code></pre> : !error && <p className="catalog-muted">文件内容为空。</p>}
    {error && <div className="catalog-error" role="alert">{error}{!content && <button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button>}</div>}
    <div className="catalog-hash"><span>SHA-256</span><code>{script.hash || '—'}</code></div>
    {releases && <div className="catalog-linked"><span>所属发布</span><div>{linked.length ? linked.map(r => <Badge key={r.id}>{r.id}{r.status === 'draft' ? ' · 草稿' : ''}</Badge>) : <span className="catalog-muted">尚未加入发布清单</span>}</div></div>}
  </Modal>;
}

function UploadDialog({ scripts, onSave, onClose }) {
  const fileInput = useRef(null);
  const submitting = useRef(false);
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState('');
  const [type, setType] = useState(scripts.some(s => s.type === 'baseline') ? 'increment' : 'baseline');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  function chooseFile(next) {
    if (busy || !next) return;
    setError(''); setFile(null);
    if (!/\.sql$/i.test(next.name)) return setError('请选择 .sql 格式的文件。');
    if (!next.size) return setError('文件内容为空，请重新选择。');
    if (next.size > 10 * 1024 * 1024) return setError('SQL 文件大小不能超过 10 MiB。');
    setFile(next);
  }
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (!file) return setError('请先选择 SQL 文件。');
    if (!description.trim()) return setError('请填写变更说明。');
    submitting.current = true; setBusy(true); setError('');
    const body = new FormData();
    body.append('file', file); body.append('description', description.trim()); body.append('db', 'business'); body.append('type', type);
    try { await onSave(body); }
    catch (err) { setError(err.message || '上传失败，请重试。'); }
    finally { submitting.current = false; setBusy(false); }
  }
  const close = () => { if (!submitting.current) onClose(); };
  return <Modal title="上传 SQL 文件" description="保留原始 SQL，上传后可加入发布清单。" onClose={close} footer={<>
    <button className="button secondary" disabled={busy} onClick={close}>取消</button>
    <button className="button primary" form="upload-sql-form" type="submit" disabled={busy}>{busy ? '正在上传…' : '上传文件'}</button>
  </>}>
    <form id="upload-sql-form" onSubmit={submit}>
      <input ref={fileInput} className="upload-hidden" type="file" accept=".sql" aria-label="选择 SQL 文件" disabled={busy} onChange={e => chooseFile(e.target.files?.[0])}/>
      <button type="button" disabled={busy} className={`upload-dropzone ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`} onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
        {file ? <IconFileTypeSql size={34} stroke={1.5}/> : <IconUpload size={30} stroke={1.5}/>}<strong>{file ? file.name : '点击选择或拖入 SQL 文件'}</strong><span>{file ? `${(file.size / 1024).toFixed(1)} KB · 点击重新选择` : '支持 .sql，使用 UTF-8 编码，最大 10 MiB'}</span>
      </button>
      {file && scripts.some(s => s.name === file.name) && <div className="catalog-info"><IconInfoCircle size={18}/><span>已有同名文件，本次上传会生成独立编号，不覆盖原文件。</span></div>}
      <div className="field"><label htmlFor="sql-description">变更说明 <span className="catalog-required">*</span></label><input id="sql-description" disabled={busy} required maxLength={100} value={description} onChange={e => setDescription(e.target.value)} placeholder="例如：初始结构与公共基础数据"/></div>
      <div className="release-form-grid"><div className="field"><label htmlFor="sql-type">文件类型</label><Select id="sql-type" disabled={busy} value={type} onChange={e => setType(e.target.value)}><option value="baseline">安装基线</option><option value="increment">增量脚本</option></Select></div><div className="field"><label htmlFor="sql-db">目标逻辑库</label><Select id="sql-db" disabled={busy} value="business" onChange={() => {}}><option value="business">business · 核心业务库</option></Select></div></div>
      <p className="catalog-footnote">{type === 'baseline' ? '基线用于空库首次安装。创建首个发布版本时，可指定它对应的版本号。' : '增量脚本用于已有环境升级。发布后，文件内容将被冻结。'}</p>
      {error && <div className="catalog-error" role="alert">{error}</div>}
    </form>
  </Modal>;
}

export function ScriptsPage({ scripts, releases, onUpload, notify }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const filtered = [...scripts].reverse().filter(s => `${s.name} ${s.id} ${s.description}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'frozen' ? s.frozen : !s.frozen)));
  return <section className="catalog-page">
    <PageHeading title="SQL 文件" subtitle="统一保存原始脚本，让每次变更都有据可查。"><button className="button primary" onClick={() => setUploadOpen(true)}><IconUpload size={18}/>上传 SQL</button></PageHeading>
    <div className="toolbar catalog-toolbar"><SearchInput value={query} onChange={setQuery} placeholder="搜索文件名、编号或说明"/><div className="catalog-tabs" role="tablist" aria-label="脚本状态">{[['all', '全部文件'], ['draft', '待发布'], ['frozen', '已冻结']].map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={filter === id ? 'active' : ''}>{label}{id === 'draft' && <span>{scripts.filter(s => !s.frozen).length}</span>}</button>)}</div></div>
    {filtered.length > 0 && <div className="catalog-table-scroll"><table className="data-table catalog-table"><thead><tr><th>SQL 文件</th><th>目标库</th><th>所属版本</th><th>状态</th><th>上传日期</th><th><span className="catalog-sr-only">操作</span></th></tr></thead><tbody>{filtered.map(script => {
      const linked = releases.filter(r => r.scriptIds.includes(script.id));
      return <tr key={script.id}><td><button className="catalog-file-button" onClick={() => setPreview(script)}><IconFileText size={22} stroke={1.5}/><span><strong>{script.description}</strong><small>{script.id} · {script.name}{script.type === 'baseline' ? ' · 基线' : ''}</small></span></button></td><td className="catalog-mono">{script.db}</td><td>{linked.length ? linked.map(r => <span key={r.id} className="catalog-release-label">{r.id}{r.status === 'draft' && <small>草稿</small>}</span>) : <span className="catalog-muted">未分配</span>}</td><td><Badge tone={script.frozen ? 'neutral' : 'blue'}>{script.frozen ? '已冻结' : '待发布'}</Badge></td><td className="catalog-muted">{dateLabel(script.createdAt)}</td><td><button className="text-button" onClick={() => setPreview(script)}>查看</button></td></tr>;
    })}</tbody></table></div>}
    {!filtered.length && <EmptyState title={scripts.length ? '没有找到匹配的文件' : '先上传第一份 SQL'} description={scripts.length ? '试试其他关键词，或上传一份新的 SQL 文件。' : '上传安装基线，建立可信起点；后续变更以增量文件管理。'}>{scripts.length ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button> : <button className="button primary" onClick={() => setUploadOpen(true)}>上传 SQL</button>}</EmptyState>}
    <footer className="catalog-table-footer"><span>共 {filtered.length} 个文件</span><span><IconLock size={15}/>已冻结的脚本通过新增文件修正</span></footer>
    {uploadOpen && <UploadDialog scripts={scripts} onClose={() => setUploadOpen(false)} onSave={async body => { await onUpload(body); setUploadOpen(false); setFilter('draft'); setQuery(''); }}/>}
    {preview && <ScriptPreview script={preview} releases={releases} onClose={() => setPreview(null)}/>}
  </section>;
}

function ReleaseEditor({ release, releases, scripts, onClose, onSave }) {
  const published = releases.filter(r => r.status === 'published');
  const latest = published.at(-1);
  const submitting = useRef(false);
  const [id, setId] = useState(release?.id || '');
  const [name, setName] = useState(release?.name || '');
  const [previous, setPrevious] = useState(release ? release.previous || '' : latest?.id || '');
  const [baseline, setBaseline] = useState(release?.baseline || scripts.find(s => s.type === 'baseline')?.id || '');
  const [notes, setNotes] = useState(release?.notes || '');
  const [selected, setSelected] = useState((release?.scriptIds || []).filter(id => scripts.find(s => s.id === id)?.type !== 'baseline'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = !previous;
  const inherited = previous ? requiredScriptIds(releases, previous) : [];
  const available = scripts.filter(s => s.type === 'increment' && !inherited.includes(s.id));
  const baselineScripts = scripts.filter(s => s.type === 'baseline');
  function toggle(scriptId) { setSelected(current => current.includes(scriptId) ? current.filter(i => i !== scriptId) : [...current, scriptId]); }
  function move(index, offset) { setSelected(current => { const next = [...current]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; }); }
  function changePrevious(value) { const ids = value ? requiredScriptIds(releases, value) : []; setPrevious(value); setSelected(current => current.filter(s => !ids.includes(s))); }
  async function submit(e) {
    e.preventDefault();
    if (submitting.current) return;
    const cleanId = id.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(cleanId)) return setError('版本号请使用 v1.5.0 这样的格式。');
    if (releases.some(r => r.id === cleanId && r.id !== release?.id)) return setError('该版本号已存在，请使用新的版本号。');
    if (!name.trim()) return setError('请填写版本名称。');
    if (first && published.length) return setError('已有发布版本，请选择前一发布版本。');
    if (first && !baselineScripts.some(s => s.id === baseline)) return setError('请先上传并选择一份安装基线。');
    if (!first) {
      const upstream = previous.slice(1).split('.').map(Number); const candidate = cleanId.slice(1).split('.').map(Number);
      const order = candidate.findIndex((n, i) => n !== upstream[i]);
      if (order < 0 || candidate[order] < upstream[order]) return setError('新版本号需要高于前一发布版本。');
    }
    if (selected.some(scriptId => !available.some(s => s.id === scriptId))) return setError('脚本清单已发生变化，请重新选择。');
    const draft = { id: cleanId, name: name.trim(), previous: previous || null, baseline: first ? baseline : releases.find(r => r.id === previous).baseline, scriptIds: first ? [baseline, ...selected] : selected, notes: notes.trim() };
    submitting.current = true; setBusy(true); setError('');
    try { await onSave(draft); }
    catch (err) { setError(err.message || '保存失败，请重试。'); }
    finally { submitting.current = false; setBusy(false); }
  }
  const close = () => { if (!submitting.current) onClose(); };
  return <Modal wide title={release ? '编辑发布草稿' : '创建发布版本'} description={first ? '指定首个基线对应的版本，并选择安装脚本。' : '选择本次新增脚本，历史版本内容将沿升级链继承。'} onClose={close} footer={<><button className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" form="release-form" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存草稿'}</button></>}>
    <form id="release-form" onSubmit={submit}>
      <fieldset className="catalog-form-fields" disabled={busy}>
        <div className="release-form-grid"><div className="field"><label htmlFor="release-id">版本号 <span className="catalog-required">*</span></label><input id="release-id" required value={id} readOnly={!!release} onChange={e => setId(e.target.value)} placeholder="例如：v1.0.0"/></div><div className="field"><label htmlFor="release-previous">前一发布版本</label><Select id="release-previous" value={previous} onChange={e => changePrevious(e.target.value)}>{(!published.length || !previous) && <option value="" disabled={published.length > 0}>首个受管理版本</option>}{[...published].reverse().map(r => <option key={r.id} value={r.id}>{r.id} · {r.name}</option>)}</Select></div></div>
        <div className="field"><label htmlFor="release-name">版本名称 <span className="catalog-required">*</span></label><input id="release-name" maxLength={60} required value={name} onChange={e => setName(e.target.value)} placeholder="例如：首次交付基线"/></div>
        {first && <div className="field"><label htmlFor="release-baseline">安装基线 <span className="catalog-required">*</span></label><Select id="release-baseline" required value={baseline} onChange={e => setBaseline(e.target.value)}><option value="">选择已上传的基线 SQL</option>{baselineScripts.map(s => <option key={s.id} value={s.id}>{s.id} · {s.description}</option>)}</Select><p className="catalog-footnote">基线固定在执行清单首位。{!baselineScripts.length && '请先在 SQL 文件页面上传安装基线。'}</p></div>}
        <div className="release-script-picker"><div className="release-picker-heading"><strong>{first ? '基线后的增量脚本（可选）' : '本次新增脚本（可选）'}</strong><span>已选 {selected.length} 个</span></div>{available.length ? available.map(s => <label key={s.id} className="release-pick-row"><input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)}/><IconFileText size={20} stroke={1.4}/><span><strong>{s.description}</strong><small>{s.id} · {s.name}</small></span></label>) : <p className="catalog-muted">暂无可选增量。{first ? '可以仅使用基线创建首个版本。' : '没有 SQL 变更时，可以保存仅更新代码的版本。'}</p>}</div>
        {!!selected.length && <div className="release-order"><label>增量执行顺序</label>{selected.map((scriptId, index) => { const script = scripts.find(s => s.id === scriptId); return <div key={scriptId} className="release-order-row"><span className="release-order-number">{String(index + (first ? 2 : 1)).padStart(2, '0')}</span><span>{script?.description || scriptId}</span><div><button type="button" className="icon-button" aria-label={`上移 ${scriptId}`} disabled={index === 0} onClick={() => move(index, -1)}><IconArrowUp size={17}/></button><button type="button" className="icon-button" aria-label={`下移 ${scriptId}`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}><IconArrowDown size={17}/></button><button type="button" className="icon-button" aria-label={`移除 ${scriptId}`} onClick={() => toggle(scriptId)}><IconX size={17}/></button></div></div>; })}</div>}
        <div className="field"><label htmlFor="release-notes">发布说明</label><textarea id="release-notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="记录本次变更和交付注意事项"/></div>
      </fieldset>
      {error && <div className="catalog-error" role="alert">{error}</div>}
    </form>
  </Modal>;
}

export function ReleasesPage({ scripts, releases, onSaveRelease, onPublishRelease, onPreview, notify }) {
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState('');
  const publishing = useRef(false);
  const selected = releases.find(r => r.id === selectedId) || releases.at(-1);
  const visible = [...releases].reverse().filter(r => `${r.id} ${r.name}`.toLowerCase().includes(query.toLowerCase()));
  const selectedScripts = (selected?.scriptIds || []).map(id => scripts.find(s => s.id === id)).filter(Boolean);
  const isDraft = selected?.status === 'draft';
  const latestPublished = releases.filter(r => r.status === 'published').at(-1);
  const validManifest = selected && selectedScripts.length === selected.scriptIds.length && (selected.previous || (selectedScripts[0]?.type === 'baseline' && selectedScripts[0]?.id === selected.baseline));
  const canPublish = selected && isDraft && validManifest && (selected.previous || null) === (latestPublished?.id || null);
  async function publish() {
    if (!canPublish || publishing.current) return;
    publishing.current = true; setPublishBusy(true); setPublishError('');
    try { await onPublishRelease(selected.id); setPublishOpen(false); }
    catch (err) { setPublishError(err.message || '发布失败，请重试。'); }
    finally { publishing.current = false; setPublishBusy(false); }
  }
  const closePublish = () => { if (!publishing.current) setPublishOpen(false); };
  return <section className="catalog-page">
    <PageHeading title="发布版本" subtitle="把代码版本与有序 SQL 清单对应起来。"><button className="button primary" onClick={() => setEditor({ mode: 'new' })}><IconPlus size={18}/>创建版本</button></PageHeading>
    {!releases.length ? <EmptyState title="建立第一个发布版本" description="先上传安装基线，再指定它对应的版本号；后续发布沿同一条升级链管理。"><button className="button primary" onClick={() => setEditor({ mode: 'new' })}>创建首个版本</button></EmptyState> : <div className="release-layout">
      <aside className="release-list"><SearchInput value={query} onChange={setQuery} placeholder="搜索发布版本"/>{visible.length ? visible.map(r => <button key={r.id} className={`release-list-item ${selected?.id === r.id ? 'selected' : ''}`} onClick={() => setSelectedId(r.id)}><span className="release-list-top"><strong>{r.id}</strong><Badge tone={r.status === 'draft' ? 'blue' : 'neutral'}>{r.status === 'draft' ? '草稿' : '已发布'}</Badge></span><span>{r.name}</span><small>{dateLabel(r.date || r.createdAt)}</small></button>) : <p className="catalog-muted release-no-match">没有匹配的版本</p>}</aside>
      {selected && <article className="release-detail"><header className="release-detail-header"><div><div className="release-title"><h2>{selected.id}</h2>{!isDraft && <IconLock size={20} stroke={1.5}/>}<Badge tone={isDraft ? 'blue' : 'neutral'}>{isDraft ? '草稿' : '已冻结'}</Badge></div><h3>{selected.name}</h3><p>{isDraft ? '创建于' : '发布于'} {dateLabel(selected.date || selected.createdAt)}<span>·</span>基线 {selected.baseline}</p></div><div className="release-header-actions">{isDraft ? <><button className="button secondary" onClick={() => setEditor({ mode: 'edit', release: selected })}>编辑草稿</button><button className="button primary" onClick={() => { setSelectedId(selected.id); setPublishError(''); setPublishOpen(true); }} disabled={!canPublish}><IconCheck size={17}/>确认发布</button></> : <button className="button primary" onClick={() => onPreview(selected.id)}>预览交付包</button>}</div></header>
        {isDraft && <div className="catalog-info"><IconInfoCircle size={18}/><span>{canPublish ? '草稿可调整脚本和顺序，发布后将冻结内容。' : latestPublished ? `请将前一版本调整为最新发布 ${latestPublished.id}，并核对脚本清单后再发布。` : '请为首个发布版本选择安装基线。'}</span></div>}
        <div className="release-section-title"><h3>{selected.previous ? '本次新增脚本' : '首次安装脚本'}</h3><span>{selectedScripts.length} 个{selectedScripts.length ? ' · 按以下顺序执行' : ' · 仅更新代码版本'}</span></div>
        {selectedScripts.length ? <div className="catalog-table-scroll"><table className="data-table release-script-table"><thead><tr><th>顺序</th><th>SQL 文件</th><th>目标库</th><th><span className="catalog-sr-only">操作</span></th></tr></thead><tbody>{selectedScripts.map((script, i) => <tr key={script.id}><td className="catalog-muted catalog-mono">{String(i + 1).padStart(2, '0')}</td><td><button className="catalog-file-button" onClick={() => setPreview(script)}><IconFileText size={21} stroke={1.5}/><span><strong>{script.description}</strong><small>{script.id} · {script.name}</small></span></button></td><td className="catalog-mono">{script.db}</td><td><button className="text-button" onClick={() => setPreview(script)}>查看</button></td></tr>)}</tbody></table></div> : <p className="release-no-sql">本次发布没有新增 SQL，数据库状态沿用前一版本。</p>}
        <div className="release-inheritance"><IconInfoCircle size={18}/><span>{selected.previous ? `继承 ${selected.previous} 的全部历史变更。导出时会根据环境台账排除已确认执行的脚本。` : '空库首次安装使用此基线，已有环境通过人工核实后接管。'}</span></div>
        <section className="release-notes"><h3>发布说明</h3><p>{selected.notes || '暂无补充说明。'}</p></section>
        {!isDraft && <p className="catalog-footnote"><IconLock size={15}/>发布内容已冻结。如需修正，请创建新版本。</p>}
      </article>}
    </div>}
    {editor && <ReleaseEditor release={editor.release} releases={releases} scripts={scripts} onClose={() => setEditor(null)} onSave={async draft => { await onSaveRelease(draft, editor.mode === 'edit'); setSelectedId(draft.id); setEditor(null); }}/> }
    {preview && <ScriptPreview script={preview} releases={releases} onClose={() => setPreview(null)}/>}
    {publishOpen && selected && <Modal title={`发布 ${selected.id}`} description="发布后，版本清单和引用脚本内容将被冻结。" onClose={closePublish} footer={<><button className="button secondary" disabled={publishBusy} onClick={closePublish}>暂不发布</button><button className="button primary" disabled={publishBusy || !canPublish} onClick={publish}>{publishBusy ? '正在发布…' : '确认发布'}</button></>}><div className="release-publish-summary"><IconLock size={30} stroke={1.4}/><h3>{selected.name}</h3><p>{selected.previous ? `包含 ${selectedScripts.length} 个新增脚本，继承 ${selected.previous} 的历史变更。` : `以 ${selected.baseline} 为安装基线，共 ${selectedScripts.length} 个脚本。`}</p><p>发布只固定交付内容，不会执行 SQL 或更新任何环境台账。</p></div>{publishError && <div className="catalog-error" role="alert">{publishError}</div>}</Modal>}
  </section>;
}
