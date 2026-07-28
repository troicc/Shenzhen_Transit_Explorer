(() => {
  const Z = window.TransitPublic;
  const TOKEN_KEY = 'transit-public-access-token';
  const pathNetwork = location.pathname.startsWith('/metro') ? 'metro' : location.pathname.startsWith('/bus') ? 'bus' : '';
  const base = pathNetwork ? `/api/${pathNetwork}` : '';

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  async function request(path) {
    const headers = {'Cache-Control': 'no-cache'};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(path, {cache: 'no-store', headers});
    if (response.status === 401) {
      const error = new Error('需要访问口令');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `请求失败 ${response.status}`);
    return payload;
  }

  Z.api = {
    network: pathNetwork,
    setToken(value) {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    },
    hasToken: () => Boolean(token()),
    networks: () => request('/api/networks'),
    runtime: () => request(`${base}/runtime`),
    manifest: () => request(`${base}/manifest`),
    line: id => request(`${base}/lines/${encodeURIComponent(id)}/scene`),
    geographic: id => request(`${base}/lines/${encodeURIComponent(id)}/geographic`),
    search: query => request(`${base}/search?q=${encodeURIComponent(query)}`),
  };
})();
