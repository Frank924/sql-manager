export function requiredScriptIds(releases = [], target) {
  if (!target) return [];
  const visited = new Set();
  function collect(id) {
    if (!id) return [];
    if (visited.has(id)) throw new Error('发布版本存在循环引用');
    visited.add(id);
    const release = releases.find(item => item.id === id);
    if (!release) throw new Error('找不到发布版本');
    return [...collect(release.previous), ...(release.scriptIds || [])];
  }
  return [...new Set(collect(target))];
}

export function pendingScriptIds(env, releases = [], target) {
  const applied = new Set(env?.applied || []);
  return requiredScriptIds(releases, target).filter(id => !applied.has(id));
}

export function confirmedVersion(env, releases = []) {
  if (!env?.baseline) return '—';
  const applied = new Set(env.applied || []);
  return releases.filter(release => {
    if (release.status !== 'published') return false;
    const ids = requiredScriptIds(releases, release.id);
    return ids.length > 0 && ids.every(id => applied.has(id) && !(env.issues || []).includes(id));
  }).at(-1)?.id || '—';
}

export function environmentState(env, releases = []) {
  if ((env?.issues || []).length) return '待核实';
  if (!env?.baseline) return '待接管';
  const latest = releases.filter(release => release.status === 'published').at(-1);
  if (!latest) return '待配置版本';
  return pendingScriptIds(env, releases, latest.id).length ? '待升级' : '已确认';
}

export function planBlocker(env, releases = [], target, type = 'upgrade') {
  if (!env) return '请先新增并选择目标环境。';
  if (releases.find(release => release.id === target)?.status !== 'published') return '请选择已发布的目标版本。';
  if ((env.issues || []).length) return '存在未核实的执行记录，请先核实并修正记录后再生成交付包。';
  if (type === 'install' && (env.baseline || (env.applied || []).length)) return '已有基线或执行记录的环境不能按空库首次安装。';
  if (type === 'upgrade' && !env.baseline) return '请先登记现有基线，或为全新空库选择首次安装。';
  const required = requiredScriptIds(releases, target);
  if (type === 'upgrade' && (env.applied || []).some(id => !required.includes(id))) return '目标版本未包含环境已登记的部分变更，不支持通过此流程降级。';
  return null;
}

// Derivation is useful for verification; mutations and authoritative ledgers belong to the server.
export function reconcileExecution(env, packages = [], scripts = [], releases = []) {
  const applied = new Set(env.baseApplied || []);
  const issues = new Set();
  for (const pkg of packages) {
    if (pkg.envId !== env.id) continue;
    for (const id of pkg.scriptIds || []) {
      if (pkg.results?.[id] === 'success') applied.add(id);
      if (['failed', 'partial'].includes(pkg.results?.[id])) issues.add(id);
    }
  }
  const installation = packages.find(pkg => pkg.envId === env.id && pkg.type === 'install');
  const anchor = releases.filter(release => release.status === 'published').at(-1)?.baseline || (installation?.scriptIds || packages.filter(pkg => pkg.envId === env.id).flatMap(pkg => pkg.scriptIds || [])).find(id => scripts.some(script => script.id === id && script.type === 'baseline'));
  const baseline = env.baseBaseline || (applied.has(anchor) ? anchor : null);
  return { ...env, applied: [...applied], issues: [...issues], baseline };
}

export function localDateTime(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function formatDateTime(value, { short = false } = {}) {
  if (!value || value === '—') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const formatted = localDateTime(parsed).replace('T', ' ');
  return short ? formatted.slice(5) : formatted;
}
