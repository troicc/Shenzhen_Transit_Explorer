export const NAV_ITEMS = Object.freeze([
  {id: 'bus-network', label: '公交全线', href: '/bus'},
  {id: 'metro-network', label: '地铁全线', href: '/metro'},
  {id: 'bus-learn', label: '公交练习', href: '/bus/learn'},
  {id: 'metro-learn', label: '地铁练习', href: '/metro/learn'},
  {id: 'bus-collector', label: '公交收集', href: '/bus/collector'},
  {id: 'metro-collector', label: '地铁收集', href: '/metro/collector'},
  {id: 'metro-studio', label: '地铁微调工作站', href: '/studio'},
]);

export function normalizeNavigationPath(pathname = '/') {
  const value = String(pathname || '/').split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return value || '/';
}

export function activeNavigationId(pathname = '/') {
  const current = normalizeNavigationPath(pathname);
  return NAV_ITEMS.find(item => item.href === current)?.id || null;
}

export function mountGlobalNavigation(
  container = typeof document === 'undefined' ? null : document.querySelector('[data-global-nav]'),
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
) {
  if (!container) return null;
  const activeId = activeNavigationId(pathname);
  container.replaceChildren();
  for (const item of NAV_ITEMS) {
    const link = document.createElement('a');
    link.href = item.href;
    link.textContent = item.label;
    link.dataset.navId = item.id;
    const active = item.id === activeId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    container.append(link);
  }
  return activeId;
}

if (typeof document !== 'undefined') mountGlobalNavigation();
