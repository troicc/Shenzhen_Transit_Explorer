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

const endpoints = networkType === 'metro'
  ? {
      overview: '/api/metro/network/overview',
      route: id => `/api/metro/learn/route/${encodeURIComponent(id)}`,
      search: (query, limit) => `/api/metro/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      language: '/api/metro/learn/language',
      languageExport: '/api/metro/learn/language/export',
      collector: '/metro/collector',
      map: '/metro',
    }
  : {
      overview: '/api/network/overview',
      route: id => `/api/learn/route/${encodeURIComponent(id)}`,
      search: (query, limit) => `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      language: '/api/learn/language',
      languageExport: '/api/learn/language/export',
      collector: '/bus/collector',
      map: '/bus',
    };

export const transitApi = {
  networkType,
  endpoints,
  publicConfig() {
    return request('/api/public/config');
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
