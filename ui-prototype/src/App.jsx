import { useState, useEffect, useRef, useCallback } from 'react';
import { IconDatabase, IconDeviceDesktop, IconFileText, IconStack2, IconPackage, IconSettings, IconPlus, IconCheck, IconInfoCircle, IconAlertCircle, IconDownload, IconHistory, IconMenu2, IconX, IconFolder, IconShieldCheck, IconEdit, IconRefresh, IconUpload } from '@tabler/icons-react';
import { Badge, PageHeading, SearchInput, Select, EmptyState, Modal } from './ui';
import { requiredScriptIds, pendingScriptIds, confirmedVersion, environmentState, planBlocker, formatDateTime } from './model';
import { apiJson, downloadApi, ApiError } from './api';
import { ScriptsPage, ReleasesPage, ScriptPreview } from './CatalogPages';
import { DeliveriesPage, ResultDialog } from './DeliveryPages';
import './catalog.css';
import './delivery.css';

const navigation = [{id:'environments',label:'环境台账',icon:IconDeviceDesktop},{id:'scripts',label:'SQL 文件',icon:IconFileText},{id:'releases',label:'发布版本',icon:IconStack2},{id:'packages',label:'交付包',icon:IconPackage}];
const emptyState = { revision:null, scripts:[], releases:[], environments:[], packages:[], settings:{} };
const segment = value => encodeURIComponent(value);
function statusTone(status) { return status === '待升级' ? 'amber' : status === '待核实' ? 'warning' : 'neutral'; }

export function App() {
  const [workspace,setWorkspace] = useState(emptyState);
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState('');
  const [saving,setSaving] = useState(false);
  const [page,setPage] = useState('environments');
  const [selectedId,setSelectedId] = useState('');
  const [target,setTarget] = useState('');
  const [query,setQuery] = useState('');
  const [filter,setFilter] = useState('all');
  const [modal,setModal] = useState(null);
  const [toast,setToast] = useState('');
  const [mobileNav,setMobileNav] = useState(false);
  const timer = useRef();
  const stateRef = useRef(emptyState);
  const mutationInFlight = useRef(false);
  const { scripts,releases,environments,packages,settings } = workspace;
  const notify = useCallback(message => {setToast(message);clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(''),5500);},[]);
  const acceptState = useCallback(data => { stateRef.current=data;setWorkspace(data); },[]);
  const refresh = useCallback(async () => { const data=await apiJson('/api/state'); acceptState(data); return data; },[acceptState]);
  const load = useCallback(async () => {setLoading(true);setLoadError('');try{await refresh();}catch(error){setLoadError(error.message);}finally{setLoading(false);}},[refresh]);
  useEffect(()=>{load();return()=>clearTimeout(timer.current);},[load]);

  async function mutate(path, body, method='POST') {
    if (mutationInFlight.current) throw new Error('另一项保存正在进行，请稍后再试。');
    if (stateRef.current.revision === null || stateRef.current.revision === undefined) throw new Error('工作区尚未加载完成，请稍后重试。');
    mutationInFlight.current=true;setSaving(true);
    try {
      const response=await apiJson(path,{method,headers:{'If-Match':String(stateRef.current.revision)},body});
      acceptState(response.state);
      return response;
    } catch(error) {
      if(error.status===409) {
        try {await refresh();} catch(refreshError) {throw new ApiError(`${error.message}；刷新失败：${refreshError.message}`,409);}
        const message=`${error.message} 已重新加载最新数据，请核对后重试；当前填写内容已保留。`;
        notify(message);
        throw new ApiError(message,409);
      }
      throw error;
    } finally { mutationInFlight.current=false;setSaving(false); }
  }
  const go = id => {setPage(id);setMobileNav(false);};
  const published = releases.filter(release=>release.status==='published');
  const currentTarget = published.find(release=>release.id===target)?.id || published.at(-1)?.id || '';
  const environment = environments.find(item=>item.id===selectedId) || environments[0];
  const pending = environment && currentTarget ? pendingScriptIds(environment,releases,currentTarget) : [];
  const selectedScripts = pending.map(id=>scripts.find(script=>script.id===id)).filter(Boolean);
  const state = environmentState(environment,releases);
  const filteredEnvironments = environments.filter(env=>env.name.toLowerCase().includes(query.toLowerCase())&&(filter==='all'||environmentState(env,releases)!=='已确认'));
  const workspaceIsEmpty = !scripts.length && !releases.length && !environments.length && !packages.length;
  const closeModal = () => setModal(null);
  const openExport = (version=currentTarget,install=false) => setModal({type:'export',envId:environment?.id,target:version,install});

  async function downloadPackage(pkg) { await downloadApi(`/api/packages/${segment(pkg.id)}/download`,`${pkg.id}.zip`);notify('交付包已下载，执行台账保持不变。'); }
  async function createPackage(values) {
    const response=await mutate('/api/packages',values);
    return response.state.packages.find(pkg=>pkg.id===response.resultId);
  }
  async function registerResult(pkg,data) {
    await mutate(`/api/packages/${segment(pkg.id)}/results`,data);
    closeModal();notify('执行结果已保存，代码版本单独维护。');
  }
  async function saveEnvironment(values,id) {
    const response=await mutate(id?`/api/environments/${segment(id)}`:'/api/environments',{...values,db:'business'},id?'PUT':'POST');
    setSelectedId(id || response.resultId);closeModal();notify(id?'环境信息已更新。':'环境已创建，请确认数据库起点。');
  }
  const activeModalEnv = environments.find(env=>env.id===modal?.envId);
  const activeModalPackage = packages.find(pkg=>pkg.id===modal?.pkgId);

  return <div className="app-shell">
    {mobileNav&&<button className="nav-backdrop" aria-label="关闭导航" onClick={()=>setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav?'open':''}`}>
      <a href="#" className="brand" onClick={event=>{event.preventDefault();go('environments');}}><IconDatabase size={42} stroke={1.8}/><span><strong>SQL Manager</strong><small>SQL 交付管理</small></span></a>
      <nav aria-label="主导航">{navigation.map(item=><button key={item.id} className={`nav-item ${page===item.id?'active':''}`} onClick={()=>go(item.id)} aria-current={page===item.id?'page':undefined}><item.icon size={25} stroke={1.6}/><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-item ${page==='settings'?'active':''}`} onClick={()=>go('settings')}><IconSettings size={25} stroke={1.6}/><span>备份与设置</span></button><div className="profile workspace-profile"><IconFolder size={23} stroke={1.5}/><span>本地工作区</span></div></div>
    </aside>
    <main className="workspace">
      <div className="topbar"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={()=>setMobileNav(true)}><IconMenu2 size={24}/></button><span>工作空间</span><span className="breadcrumb-slash">/</span><strong>{settings.workspaceName || 'SQL Manager'}</strong>{saving&&<span className="save-indicator" role="status">正在保存…</span>}</div>
      {loading?<div className="workspace-message" role="status"><IconDatabase size={36} stroke={1.3}/><h2>正在加载工作区</h2><p>读取已保存的脚本与环境记录。</p></div>:loadError?<div className="workspace-message" role="alert"><IconAlertCircle size={36}/><h2>暂时无法读取工作区</h2><p>{loadError}</p><button className="button primary" onClick={load}><IconRefresh size={18}/>重新连接</button></div>:<>
        {page==='environments'&&<>
          <PageHeading title="环境台账" subtitle="查看环境进度，准备下一次交付。"><button className="button outline-blue" onClick={()=>setModal({type:'environment'})}><IconPlus size={18}/>新增环境</button></PageHeading>
          {!environments.length?<WorkspaceSetup scripts={scripts} releases={releases} onNavigate={go} onNewEnvironment={()=>setModal({type:'environment'})}/>:<>
            <div className="toolbar env-toolbar"><SearchInput value={query} onChange={setQuery} placeholder="搜索环境名称"/><div className="tabs" role="tablist" aria-label="环境筛选"><button role="tab" aria-selected={filter==='all'} className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>全部环境</button><button role="tab" aria-selected={filter==='pending'} className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>待处理</button></div></div>
            <div className="env-grid">
              <section className="environment-list" aria-label="环境列表"><div className="table-scroll"><table className="data-table env-table"><thead><tr><th>环境</th><th>代码版本</th><th>SQL 状态</th><th>最近登记</th></tr></thead><tbody>{filteredEnvironments.map(env=>{const status=environmentState(env,releases);return <tr key={env.id} className={env.id===environment?.id?'selected':''} onClick={()=>setSelectedId(env.id)}><td><button className="row-select" onClick={()=>setSelectedId(env.id)} aria-pressed={env.id===environment?.id}>{env.name}</button><small>{env.kind}</small></td><td className="mono">{env.codeVersion||'—'}</td><td>{status==='已确认'||status==='待接管'?status:<Badge tone={statusTone(status)}>{status}</Badge>}</td><td className="mono date-cell"><time title={formatDateTime(env.last)}>{formatDateTime(env.last,{short:true})}</time></td></tr>;})}</tbody></table></div>{!filteredEnvironments.length&&<EmptyState title="没有找到环境" description="试试其他名称，或查看全部环境。"/>}<div className="list-footer">共 {filteredEnvironments.length} 个环境</div></section>
              {environment&&<aside className="environment-detail" aria-label="环境详情">
                <div className="detail-title"><div><h2>{environment.name}</h2><p className="detail-subtitle">{environment.kind}</p></div><button className="icon-button" aria-label={`编辑 ${environment.name}`} onClick={()=>setModal({type:'environment',envId:environment.id})}><IconEdit size={20}/></button></div>
                <dl className="detail-meta"><div><dt>逻辑库</dt><dd className="mono">{environment.db}</dd></div><div><dt>实际数据库</dt><dd className="mono">{environment.actualDb}</dd></div><div><dt>已确认基线</dt><dd className="mono">{environment.baseline||'尚未登记'}</dd></div><div><dt>已确认 SQL 版本</dt><dd className="mono">{confirmedVersion(environment,releases)}</dd></div></dl>
                {published.length?<div className="target-version"><label htmlFor="target-release">目标版本</label><Select id="target-release" value={currentTarget} onChange={event=>setTarget(event.target.value)}>{published.map(release=><option key={release.id} value={release.id}>{release.id}</option>)}</Select></div>:<div className="notice"><IconInfoCircle size={20}/><div>先上传基线并配置首个发布版本。<button className="text-button full" onClick={()=>go('releases')}>前往发布版本</button></div></div>}
                {state==='待接管'?<div className="detail-empty"><IconDatabase size={32} stroke={1.4}/><h3>先确认数据库起点</h3><p>已有数据库请登记已核实的基线；全新空库可以生成首次安装包。</p><button className="button primary full" disabled={!published.length} onClick={()=>setModal({type:'baseline',envId:environment.id})}>登记现有基线</button><button className="button secondary full" disabled={!published.length} onClick={()=>openExport(currentTarget,true)}>为全新空库生成安装包</button></div>:<>
                  {!!environment.issues?.length&&<div className="notice warning"><IconAlertCircle size={20}/><span>存在待核实项，先确认现场状态，再准备下一次交付。</span></div>}
                  {published.length>0&&<div className="pending-section"><h3>{pending.length?`本次需交付 ${pending.length} 个脚本`:'目标版本无需新增 SQL'}</h3>{selectedScripts.length?<div className="pending-list">{selectedScripts.map(script=><button key={script.id} className="pending-item" onClick={()=>setModal({type:'script',script})}><IconFileText size={21} stroke={1.6}/><span className="mono">{script.id}</span><span>{script.description}</span></button>)}</div>:<p className="muted">所需脚本均已确认完成。运行中的代码版本仍需单独维护。</p>}</div>}
                  {published.length>0&&<div className="detail-actions"><button className="button primary full" disabled={!!planBlocker(environment,releases,currentTarget)||!pending.length} onClick={()=>openExport()}>预览升级包</button><p className="helper">导出后仍需登记现场执行结果</p></div>}
                </>}
                <button className="text-button history-link" onClick={()=>setModal({type:'history',envId:environment.id})}>查看执行记录</button>
                {!!environment.issues?.length&&<button className="text-button" onClick={()=>go('packages')}>前往交付包核实登记</button>}
              </aside>}
            </div>
          </>}
        </>}
        {page==='scripts'&&<ScriptsPage {...{scripts,releases,notify}} onUpload={async data=>{const response=await mutate('/api/scripts',data);notify('SQL 文件已保存。');return response;}}/>}
        {page==='releases'&&<ReleasesPage {...{scripts,releases,notify}} onSaveRelease={async (draft,isEdit)=>{const response=await mutate(isEdit?`/api/releases/${segment(draft.id)}`:'/api/releases',draft,isEdit?'PUT':'POST');notify('发布草稿已保存。');return response;}} onPublishRelease={async id=>{const response=await mutate(`/api/releases/${segment(id)}/publish`,{});notify('版本已发布，清单与脚本内容已冻结。');return response;}} onPreview={version=>{setTarget(version);openExport(version);}}/>}
        {page==='packages'&&<DeliveriesPage {...{packages,environments,scripts}} onRegister={pkg=>setModal({type:'result',pkgId:pkg.id})} onDownload={pkg=>downloadPackage(pkg).catch(error=>notify(error.message))} onNew={()=>openExport()}/>}
        {page==='settings'&&<SettingsPage settings={settings} isEmpty={workspaceIsEmpty} onBackup={()=>downloadApi('/api/backup','sql-manager-backup.zip')} onRestore={async form=>{const response=await mutate('/api/restore',form);notify('工作区备份已恢复。');return response;}}/>}
      </>}
    </main>
    {toast&&<div className="toast" role="status"><IconInfoCircle size={20}/>{toast}<button aria-label="关闭通知" className="icon-button" onClick={()=>setToast('')}><IconX size={16}/></button></div>}
    {modal?.type==='environment'&&<EnvironmentDialog key={modal.envId||'new'} environment={activeModalEnv} hasDeliveries={packages.some(pkg=>pkg.envId===modal.envId)} onClose={closeModal} onSave={values=>saveEnvironment(values,modal.envId)}/>}
    {modal?.type==='baseline'&&activeModalEnv&&<BaselineDialog env={activeModalEnv} releases={releases} onClose={closeModal} onSave={async values=>{await mutate(`/api/environments/${segment(activeModalEnv.id)}/baseline`,values);closeModal();notify('基线确认已保存，未执行 SQL。');}}/>}
    {modal?.type==='export'&&<ExportDialog initialEnvId={modal.envId} initialTarget={modal.target} install={modal.install} {...{environments,releases,scripts}} onClose={closeModal} onCreate={createPackage} onDownload={downloadPackage} onNavigate={id=>{closeModal();go(id);}} onDone={()=>{closeModal();go('packages');}}/>}
    {modal?.type==='result'&&activeModalPackage&&<ResultDialog key={activeModalPackage.id} pkg={activeModalPackage} scripts={activeModalPackage.files||scripts} environment={environments.find(env=>env.id===activeModalPackage.envId)} onClose={closeModal} onSave={data=>registerResult(activeModalPackage,data)}/>}
    {modal?.type==='history'&&activeModalEnv&&<HistoryDialog environment={activeModalEnv} onClose={closeModal}/>}
    {modal?.type==='script'&&<ScriptPreview script={modal.script} releases={releases} onClose={closeModal}/>}
  </div>;
}

function WorkspaceSetup({scripts,releases,onNavigate,onNewEnvironment}) {
  const hasBaseline=scripts.some(script=>script.type==='baseline');
  const hasPublished=releases.some(release=>release.status==='published');
  return <section className="workspace-setup"><div className="setup-intro"><IconDatabase size={42} stroke={1.3}/><h2>建立你的 SQL 交付工作区</h2><p>先确定一个可信的发布起点，再逐步登记各环境。</p></div><div className="setup-steps">
    <div><span className={`setup-step ${hasBaseline?'done':''}`}>{hasBaseline?<IconCheck size={20}/>:1}</span><div><h3>上传基线 SQL</h3><p>保存初始结构和必要基础数据的原始文件。</p></div><button className="button secondary" onClick={()=>onNavigate('scripts')}>{hasBaseline?'查看 SQL 文件':'上传 SQL'}</button></div>
    <div><span className={`setup-step ${hasPublished?'done':''}`}>{hasPublished?<IconCheck size={20}/>:2}</span><div><h3>配置首个发布版本</h3><p>指定基线对应版本，确认清单和执行顺序后发布。</p></div><button className="button secondary" onClick={()=>onNavigate('releases')}>{hasPublished?'查看发布版本':'配置发布版本'}</button></div>
    <div><span className="setup-step">3</span><div><h3>新增部署环境</h3><p>登记本地、测试或客户环境，确认现有基线或准备空库安装。</p></div><button className="button primary" onClick={onNewEnvironment}>新增环境</button></div>
  </div></section>;
}

function EnvironmentDialog({environment,hasDeliveries,onClose,onSave}) {
  const [values,setValues]=useState({name:environment?.name||'',kind:environment?.kind||'独立部署',codeVersion:environment?.codeVersion||'',actualDb:environment?.actualDb||''});
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const databaseLocked=!!environment&&(hasDeliveries||!!environment.baseApplied?.length||!!environment.applied?.length||!!environment.issues?.length);
  const update=(key,value)=>setValues(previous=>({...previous,[key]:value}));
  async function submit(event){event.preventDefault();if(busy)return;setBusy(true);setError('');try{await onSave({...values,name:values.name.trim(),actualDb:databaseLocked?environment.actualDb:values.actualDb.trim(),codeVersion:values.codeVersion.trim()});}catch(failure){setError(failure.message);}finally{setBusy(false);}}
  return <Modal title={environment?'编辑环境信息':'新增环境'} description={environment?'代码版本单独维护，不改变 SQL 执行台账。':'登记基本信息后，再确认数据库起点。'} onClose={()=>{if(!busy)onClose();}} footer={<><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="submit" form="environment-form" disabled={busy}>{busy?'正在保存…':environment?'保存环境':'创建环境'}</button></>}>
    <form id="environment-form" onSubmit={submit}>
      <label className="field">环境名称<input required maxLength={80} value={values.name} onChange={event=>update('name',event.target.value)} placeholder="例如：公司测试环境"/></label>
      <label className="field">环境类型<Select value={values.kind} onChange={event=>update('kind',event.target.value)}>{['开发环境','测试环境','生产环境','独立部署'].map(kind=><option key={kind}>{kind}</option>)}</Select></label>
      <div className="field"><label htmlFor="environment-databases">实际数据库名</label><textarea id="environment-databases" required rows={3} maxLength={4000} readOnly={databaseLocked} aria-describedby="environment-databases-help" value={databaseLocked?environment.actualDb:values.actualDb} onChange={event=>update('actualDb',event.target.value)} placeholder={'例如：lims-cloud\nlims-config'}/><span id="environment-databases-help" className="optional">{databaseLocked?'已有交付或台账，数据库名已锁定。仍可修改环境名称、类型和代码版本。':'支持多个数据库名，用逗号、中文逗号、顿号或换行分隔，每个名称最多 64 个字符。'}</span></div>
      <label className="field">当前运行代码版本 <span className="optional">选填</span><input maxLength={80} value={values.codeVersion} onChange={event=>update('codeVersion',event.target.value)} placeholder="例如：v1.0.0"/></label>
      <div className="notice"><IconInfoCircle size={20}/><span>填写代码版本不会标记任何脚本为成功。数据库名列表用于交付说明，各库共用此环境的脚本执行台账。</span></div>
      {error&&<p className="form-error" role="alert">{error}</p>}
    </form>
  </Modal>;
}

function BaselineDialog({env,releases,onSave,onClose}) {
  const published=releases.filter(release=>release.status==='published');
  const [version,setVersion]=useState(published[0]?.id||'');
  const [operator,setOperator]=useState('');const [note,setNote]=useState('');
  const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const validVersion=published.some(release=>release.id===version);
  async function submit(event){event.preventDefault();if(busy||!confirmed||!validVersion)return;setBusy(true);setError('');try{await onSave({version,operator:operator.trim(),note:note.trim(),confirmed:true});}catch(failure){setError(failure.message);}finally{setBusy(false);}}
  return <Modal title="登记现有基线" description={`${env.name} · ${env.actualDb}`} onClose={()=>{if(!busy)onClose();}} footer={<><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="submit" form="baseline-form" disabled={busy||!confirmed||!validVersion}>{busy?'正在保存…':'确认接管状态'}</button></>}>
    {published.length?<form id="baseline-form" onSubmit={submit}><label className="field">已核实达到的版本<Select value={version} onChange={event=>{setVersion(event.target.value);setConfirmed(false);}}>{published.map(release=><option key={release.id} value={release.id}>{release.id} · {release.name}</option>)}</Select></label><div className="notice"><IconInfoCircle size={20}/><span>确认基线及截至此版本的 {validVersion?requiredScriptIds(releases,version).length:0} 项变更已具备。此操作记录确认状态，不执行 SQL，不生成历史执行时间。</span></div><label className="field">确认人<input required maxLength={80} value={operator} onChange={event=>setOperator(event.target.value)} placeholder="填写核实人员姓名"/></label><label className="field">核实依据<textarea required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)} placeholder="说明现场结构、必要基础数据和版本的核对依据" rows={3}/></label><label className="check-line"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核对现场结构及必要数据，确认达到所选版本。</span></label>{error&&<p className="form-error" role="alert">{error}</p>}</form>:<EmptyState title="还没有已发布版本" description="先上传基线文件并配置首个发布版本。"/>}
  </Modal>;
}

function ExportDialog({initialEnvId,initialTarget,install=false,environments,releases,scripts,onCreate,onDownload,onDone,onNavigate,onClose}) {
  const published=releases.filter(release=>release.status==='published');
  const [envId,setEnvId]=useState(initialEnvId||environments[0]?.id||'');
  const [version,setVersion]=useState(initialTarget||published.at(-1)?.id||'');
  const [type,setType]=useState(install?'install':'upgrade');
  const [emptyConfirmed,setEmptyConfirmed]=useState(false);const [pkg,setPkg]=useState(null);
  const [busy,setBusy]=useState(false);const [downloading,setDownloading]=useState(false);const [error,setError]=useState('');
  const env=environments.find(item=>item.id===envId);
  const validTarget=published.some(release=>release.id===version);
  const ids=validTarget?(type==='install'?requiredScriptIds(releases,version):pendingScriptIds(env,releases,version)):[];
  const blocker=planBlocker(env,releases,version,type);
  const missingSetup=!environments.length||!published.length;
  async function generate(){if(busy)return;setBusy(true);setError('');try{const created=await onCreate({envId,target:version,type,confirmedEmpty:type==='install'&&emptyConfirmed});if(!created)throw new Error('交付包已保存，但未能读取包信息。请关闭后查看交付包列表。');setPkg(created);}catch(failure){setError(failure.message);}finally{setBusy(false);}}
  async function download(){if(downloading)return;setDownloading(true);setError('');try{await onDownload(pkg);}catch(failure){setError(failure.message);}finally{setDownloading(false);}}
  return <Modal title={pkg?'交付包已生成':type==='install'?'预览首次安装包':'预览升级包'} description={pkg?`${pkg.id} · ${pkg.envName}`:'核对目标环境与执行顺序，生成现场交付文件。'} wide onClose={()=>{if(!busy&&!downloading)onClose();}} footer={pkg?<><button className="button secondary" disabled={downloading} onClick={download}><IconDownload size={18}/>{downloading?'正在下载…':'下载交付包'}</button><button className="button primary" disabled={downloading} onClick={onDone}>前往登记结果</button></>:<><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy||!!blocker||!ids.length||(type==='install'&&!emptyConfirmed)} onClick={generate}>{busy?'正在生成…':'生成交付包'}</button></>}>
    {pkg?<div className="export-success"><IconShieldCheck size={54} stroke={1.3}/><h3>{pkg.scriptIds.length} 个 SQL 文件已按顺序归档</h3><p>环境执行台账尚未更新。现场执行完成后，请逐文件登记实际结果。</p><div className="package-contents"><span><IconFileText size={19}/>原始 SQL 文件</span><span><IconStack2 size={19}/>执行顺序说明</span><span><IconShieldCheck size={19}/>文件校验清单</span><span><IconHistory size={19}/>结果登记表</span></div></div>:missingSetup?<EmptyState title={!environments.length?'先登记目标环境':'先发布一个版本'} description={!environments.length?'交付包需要明确的目标环境和实际数据库。':'发布版本决定本次需要交付的 SQL 清单。'}><button className="button primary" onClick={()=>onNavigate(!environments.length?'environments':'releases')}>{!environments.length?'前往环境台账':'前往发布版本'}</button></EmptyState>:<>
      <div className="form-grid"><label className="field">目标环境<Select value={envId} onChange={event=>{setEnvId(event.target.value);setEmptyConfirmed(false);setError('');}}>{environments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label><label className="field">目标发布版本<Select value={version} onChange={event=>{setVersion(event.target.value);setEmptyConfirmed(false);setError('');}}>{published.map(release=><option key={release.id} value={release.id}>{release.id}</option>)}</Select></label></div>
      <div className="export-context"><span>目标库 <strong className="mono">{env?.actualDb||'—'}</strong></span><span>已确认 SQL 版本 <strong className="mono">{confirmedVersion(env,releases)}</strong></span><Select aria-label="交付类型" value={type} onChange={event=>{setType(event.target.value);setEmptyConfirmed(false);setError('');}}><option value="upgrade">增量升级</option><option value="install">首次安装</option></Select></div>
      {blocker&&<div className="notice warning"><IconAlertCircle size={20}/><span>{blocker}</span></div>}
      <div className="section-heading"><h3>待交付脚本</h3><span>{ids.length} 个 · 按发布顺序执行</span></div><div className="table-scroll"><table className="data-table export-table"><thead><tr><th>顺序</th><th>SQL 文件</th><th>目标库</th></tr></thead><tbody>{ids.map((id,index)=>{const script=scripts.find(item=>item.id===id);return <tr key={id}><td className="mono muted">{String(index+1).padStart(2,'0')}</td><td><strong>{script?.description||id}</strong><small className="mono">{script?.name}</small></td><td className="mono">{script?.db}</td></tr>;})}</tbody></table></div>{!ids.length&&<EmptyState title="无需新增 SQL" description="该版本所需脚本均已确认完成，代码版本请单独维护。"/>}
      {type==='install'&&<label className="check-line"><input type="checkbox" checked={emptyConfirmed} onChange={event=>setEmptyConfirmed(event.target.checked)}/><span>我已确认所有目标数据库均为全新空库。</span></label>}
      <div className="notice"><IconInfoCircle size={20}/><span>生成交付包不会更新执行台账。实际数据库名写入交付说明，SQL 原文件不会被自动改写。</span></div>
    </>}{error&&<p className="form-error" role="alert">{error}</p>}
  </Modal>;
}

function HistoryDialog({environment,onClose}) {
  const records=environment.history||[];
  return <Modal title={`${environment.name} · 执行记录`} description="以人工登记结果为依据，代码版本单独维护。" onClose={onClose} footer={<button className="button secondary" onClick={onClose}>关闭</button>}><dl className="record-meta"><div><dt>实际库名</dt><dd>{environment.actualDb}</dd></div><div><dt>已确认脚本</dt><dd>{environment.applied?.length||0} 个</dd></div></dl>{records.length?<div className="history-list">{records.map((record,index)=><div key={record.id||index}><IconHistory size={19}/><div><small>{formatDateTime(record.date||record.recordedAt||record.confirmedAt)}</small><h3>{record.title||'执行状态登记'}</h3><p>{record.detail||''}</p>{record.note&&<p>依据 / 备注：{record.note}</p>}{record.operator&&<p>登记人：{record.operator}</p>}</div></div>)}</div>:<EmptyState title="暂无登记记录" description="可以登记现有基线，或在现场执行后从交付包页面登记结果。"/>}</Modal>;
}

function SettingsPage({settings,isEmpty,onBackup,onRestore}) {
  const [backingUp,setBackingUp]=useState(false);const [restoring,setRestoring]=useState(false);
  const [file,setFile]=useState(null);const [confirmed,setConfirmed]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');
  const fileRef=useRef(null);
  async function backup(){if(backingUp)return;setBackingUp(true);setError('');setMessage('');try{await onBackup();setMessage('完整备份已下载，请妥善保存在其他磁盘或机器。');}catch(failure){setError(failure.message);}finally{setBackingUp(false);}}
  async function restore(event){event.preventDefault();if(restoring||!file||!confirmed||!isEmpty)return;setRestoring(true);setError('');setMessage('');const form=new FormData();form.append('file',file);form.append('confirmed','true');try{await onRestore(form);setFile(null);setConfirmed(false);if(fileRef.current)fileRef.current.value='';setMessage('工作区已恢复，可以继续查看环境与发布记录。');}catch(failure){setError(failure.message);}finally{setRestoring(false);}}
  return <><PageHeading title="备份与设置" subtitle="保留交付资料，让环境记录有据可查。"/><div className="settings-content">
    <section><IconFolder size={28} stroke={1.5}/><div><h2>本地数据目录</h2><p>SQL 原文件、发布清单与执行台账保存在运行服务的机器上。</p><code className="data-directory">{settings.dataDirectory||'数据目录不可用'}</code><p className="settings-helper">切换本地或 Docker 运行方式时，应迁移完整数据目录或使用工作区备份。</p></div></section>
    <section><IconDownload size={28} stroke={1.5}/><div><h2>完整备份</h2><p>下载 SQL 原文件、环境信息、发布清单和登记历史的一致性备份。</p><button className="button secondary" disabled={backingUp||restoring} onClick={backup}><IconDownload size={18}/>{backingUp?'正在准备备份…':'下载完整备份'}</button></div></section>
    <section><IconUpload size={28} stroke={1.5}/><div><h2>恢复工作区</h2><p>仅可恢复到空工作区。系统会核对备份中的文件与记录后再写入。</p>{isEmpty?<form onSubmit={restore} className="restore-form"><label className="field">选择备份 ZIP 文件<input ref={fileRef} type="file" accept=".zip,application/zip" required disabled={restoring} onChange={event=>{setFile(event.target.files?.[0]||null);setConfirmed(false);setError('');}}/></label><label className="check-line"><input type="checkbox" checked={confirmed} disabled={restoring} onChange={event=>setConfirmed(event.target.checked)}/><span>我确认将此备份恢复到当前空工作区。</span></label><button className="button secondary" type="submit" disabled={restoring||backingUp||!file||!confirmed}><IconUpload size={18}/>{restoring?'正在校验并恢复…':'恢复备份'}</button></form>:<div className="notice"><IconInfoCircle size={20}/><span>当前工作区已有数据。请使用空的数据目录启动服务后，再恢复备份。</span></div>}</div></section>
    {message&&<p className="settings-success" role="status"><IconCheck size={18}/>{message}</p>}{error&&<p className="form-error" role="alert">{error}</p>}
  </div></>;
}
