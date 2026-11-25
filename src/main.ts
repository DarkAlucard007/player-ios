// 入口：路由注册 + 底部标签栏 + 播放器路由

import './style.css';
import { registerRoute, initRouter, currentRoute } from './router';
import { openPlayer, closePlayer } from './player/player';
import { renderHome } from './views/home';
import { renderLibrary } from './views/library';
import { renderBrowse } from './views/browse';
import { renderSearch } from './views/search';
import { renderPlaylists } from './views/playlists';
import { renderSettings } from './views/settings';
import { renderSourceAdd, renderSourceEdit } from './views/sources';

registerRoute('home', (el) => renderHome(el));
registerRoute('library', (el) => renderLibrary(el));
registerRoute('browse', (el, hash) => renderBrowse(el, hash));
registerRoute('search', (el) => renderSearch(el));
registerRoute('playlists', (el) => renderPlaylists(el));
registerRoute('settings', (el) => renderSettings(el));
registerRoute('source-add', (el) => renderSourceAdd(el));
registerRoute('source-edit', (el, hash) => {
  const id = new URLSearchParams(hash.split('?')[1] || '').get('id') || '';
  renderSourceEdit(el, id);
});

// 播放器是全屏覆盖层，不走标签栏
registerRoute('player', (el, hash) => {
  el.innerHTML = '';
  const query = new URLSearchParams(hash.split('?')[1] || '');
  const key = query.get('key') || '';
  if (!key) {
    closePlayer();
    return;
  }
  openPlayer(key);
});

// 底部标签栏
function buildTabbar(): void {
  const bar = document.createElement('nav');
  bar.id = 'tabbar';
  bar.innerHTML = `
    <a href="#/home" class="tab" data-route="home"><span class="tab-ico">🏠</span><span class="tab-label">首页</span></a>
    <a href="#/library" class="tab" data-route="library"><span class="tab-ico">🎬</span><span class="tab-label">媒体库</span></a>
    <a href="#/browse" class="tab" data-route="browse"><span class="tab-ico">📡</span><span class="tab-label">浏览</span></a>
    <a href="#/search" class="tab" data-route="search"><span class="tab-ico">🔍</span><span class="tab-label">搜索</span></a>
    <a href="#/playlists" class="tab" data-route="playlists"><span class="tab-ico">📃</span><span class="tab-label">列表</span></a>
    <a href="#/settings" class="tab" data-route="settings"><span class="tab-ico">⚙️</span><span class="tab-label">设置</span></a>
  `;
  document.body.appendChild(bar);
  const mark = () => {
    const { name } = currentRoute();
    bar.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.route === name);
    });
  };
  window.addEventListener('hashchange', mark);
  mark();
}

buildTabbar();
if (!location.hash) location.hash = '#/home';
initRouter();
