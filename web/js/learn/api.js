async function request(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    const detail = typeof payload === 'object' ? payload.detail : payload;
    throw new Error(detail || `请求失败 ${response.status}`);
  }
  return payload;
}

const params = new URLSearchParams(window.location.search);
const requestedNetwork = params.get('network');
const pathNetwork = window.location.pathname.startsWith('/metro/') ? 'metro' : window.location.pathname.startsWith('/bus/') ? 'bus' : null;
export const networkType = pathNetwork || (requestedNetwork === 'metro' ? 'metro' : 'bus');

const base = `/api/${networkType}`;
const endpoints = {
  overview: `${base}/network/overview`,
  route: id => `${base}/learn/routes/${encodeURIComponent(id)}`,
  search: (query, limit) => `${base}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  language: `${base}/learn/language`,
  languageExport: `${base}/learn/language/export`,
  collector: `/${networkType}/collector`,
  map: `/${networkType}`,
};

export const transitApi = {
  networkType,
  endpoints,
  async publicConfig() {
    const runtime = await request('/api/runtime');
    return {...(runtime.amap || {}), admin_enabled: runtime.edition === 'internal'};
  },
  overview() {
    return request(endpoints.overview);
  },
  route(routeId) {
    return request(endpoints.route(routeId));
  },
  search(query, limit = 30) {
    return request(endpoints.search(query, limit));
  },
  updateLanguage(payload) {
    return request(endpoints.language, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
  },
};
