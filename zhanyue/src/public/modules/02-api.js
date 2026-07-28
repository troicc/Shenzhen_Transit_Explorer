(() => {
  const Z = window.ZhanyuePublic;
  const TOKEN_KEY = 'zhanyue-public-access-token';

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
    setToken(value) {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    },
    hasToken: () => Boolean(token()),
    runtime: () => request('/api/runtime'),
    manifest: () => request('/api/manifest'),
    line: id => request(`/api/lines/${encodeURIComponent(id)}/scene`),
    geographic: id => request(`/api/lines/${encodeURIComponent(id)}/geographic`),
    search: query => request(`/api/search?q=${encodeURIComponent(query)}`),
  };
})();
