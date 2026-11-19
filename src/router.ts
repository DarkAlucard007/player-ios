// 轻量 hash 路由

type RouteHandler = (el: HTMLElement, hash: string) => void;

const routes = new Map<string, RouteHandler>();

export function registerRoute(name: string, handler: RouteHandler): void {
  routes.set(name, handler);
}

export function nav(hash: string): void {
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

export function currentRoute(): { name: string; query: URLSearchParams } {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const [name, qs] = raw.split('?');
  return { name: name || 'home', query: new URLSearchParams(qs || '') };
}

export function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const { name, query } = currentRoute();
  const handler = routes.get(name) || routes.get('home')!;
  app.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'page';
  app.appendChild(el);
  handler(el, '#' + name + (query.toString() ? '?' + query.toString() : ''));
  // 播放器打开时隐藏标签栏
  const tabs = document.getElementById('tabbar');
  if (tabs) tabs.style.display = name === 'player' ? 'none' : '';
}

export function initRouter(): void {
  window.addEventListener('hashchange', render);
  render();
}
