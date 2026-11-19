// 通用 UI 组件：toast / 模态弹窗 / 确认框

export function toast(msg: string): void {
  let el = document.querySelector('.app-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  window.setTimeout(() => el!.classList.remove('show'), 2200);
}

/** 打开模态弹窗，content 为 HTML 字符串。返回容器元素，调用方自行绑定事件。 */
export function modal(title: string, content: string): HTMLElement {
  closeModals();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal-mask';
  wrap.innerHTML = `
    <div class="app-modal">
      <div class="app-modal-head">
        <span>${title}</span>
        <button class="app-modal-x" aria-label="关闭">×</button>
      </div>
      <div class="app-modal-body">${content}</div>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.querySelector('.app-modal-x')!.addEventListener('click', () => wrap.remove());
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) wrap.remove();
  });
  return wrap;
}

export function closeModals(): void {
  document.querySelectorAll('.app-modal-mask').forEach((m) => m.remove());
}

/** 确认框，返回是否确认 */
export function confirmDialog(message: string, okText = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = modal('提示', `<p class="app-confirm-msg">${message}</p>`);
    const body = wrap.querySelector('.app-modal-body')!;
    const btns = document.createElement('div');
    btns.className = 'app-confirm-btns';
    btns.innerHTML = `<button class="app-btn" data-a="no">取消</button><button class="app-btn primary" data-a="yes">${okText}</button>`;
    body.appendChild(btns);
    btns.querySelector('[data-a="no"]')!.addEventListener('click', () => {
      wrap.remove();
      resolve(false);
    });
    btns.querySelector('[data-a="yes"]')!.addEventListener('click', () => {
      wrap.remove();
      resolve(true);
    });
  });
}

/** 简单的文本输入弹窗 */
export function promptDialog(title: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = modal(title, `<input class="app-input" type="text" placeholder="${placeholder}" />`);
    const body = wrap.querySelector('.app-modal-body')!;
    const input = body.querySelector<HTMLInputElement>('.app-input')!;
    const btns = document.createElement('div');
    btns.className = 'app-confirm-btns';
    btns.innerHTML = `<button class="app-btn" data-a="no">取消</button><button class="app-btn primary" data-a="yes">确定</button>`;
    body.appendChild(btns);
    setTimeout(() => input.focus(), 50);
    const finish = (v: string | null) => {
      wrap.remove();
      resolve(v);
    };
    btns.querySelector('[data-a="no"]')!.addEventListener('click', () => finish(null));
    btns.querySelector('[data-a="yes"]')!.addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
    });
  });
}
