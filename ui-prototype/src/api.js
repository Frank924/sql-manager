export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined && body !== null && !(body instanceof FormData) && typeof body !== 'string' && !(body instanceof Blob)) {
    body = JSON.stringify(body);
    headers.set('Content-Type', 'application/json');
  }
  let response;
  try { response = await fetch(path, { ...options, body, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('无法连接本地服务，请检查服务是否正在运行后重试。');
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { const data = await response.json(); if (typeof data.message === 'string' && data.message.trim()) message = data.message; }
    catch { /* A proxy or network error may not have a JSON body. */ }
    throw new ApiError(message, response.status);
  }
  return response;
}

export async function apiJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  const response = await request(path, { ...options, headers });
  if (response.status === 204) return null;
  try { return await response.json(); }
  catch { throw new ApiError('服务返回的数据格式不正确，请重试。', response.status); }
}

export async function apiText(path, options = {}) {
  return (await request(path, options)).text();
}

export async function downloadApi(path, filename) {
  const response = await request(path);
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  let suggestedName;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { suggestedName = decodeURIComponent(encoded); } catch { /* Use the supplied name if malformed. */ } }
  if (!suggestedName) suggestedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const name = (suggestedName || filename || 'download').split(/[\\/]/).at(-1);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
