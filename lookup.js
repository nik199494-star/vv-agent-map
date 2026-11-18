export function setupLookup({input, options, status, lookup, onSelect, min = 3, debounce = 650, empty = 'Ничего не найдено'}) {
  let suggestions = [];
  let active = -1;
  let timer, controller;

  function message(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function close() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    suggestions = [];
    active = -1;
    options.hidden = true;
    options.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    message('');
  }

  function choose(item) {
    close();
    input.value = item.label;
    onSelect(item);
  }

  function show(items) {
    suggestions = items;
    options.replaceChildren(...items.map((item, i) => {
      const option = document.createElement('li');
      option.id = `${options.id}-${i}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.index = i;
      const title = document.createElement('strong');
      title.textContent = item.label;
      const detail = document.createElement('small');
      detail.textContent = [item.kind, item.area].filter(Boolean).join(' · ');
      option.append(title, detail);
      return option;
    }));
    options.hidden = !items.length;
    input.setAttribute('aria-expanded', String(Boolean(items.length)));
    message(items.length ? '' : empty);
  }

  function queue() {
    close();
    const value = input.value.trim();
    if (value.length < min) return;
    timer = setTimeout(async () => {
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 9000);
      message('Ищем…');
      try {
        const items = await lookup(value, request.signal);
        if (!request.signal.aborted) show(items);
        else if (timedOut && controller === request) message('Поиск временно недоступен. Повторите запрос.');
      } catch (error) {
        if (!request.signal.aborted || timedOut && controller === request) {
          message(error instanceof TypeError || timedOut ? 'Поиск временно недоступен. Повторите запрос.' : error.message);
        }
      } finally { clearTimeout(timeout); }
    }, debounce);
  }

  input.addEventListener('input', queue);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = suggestions[active] ?? (suggestions.length === 1 ? suggestions[0] : null);
      if (item) choose(item);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !suggestions.length) return;
    event.preventDefault();
    active = (active + (event.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + suggestions.length) % suggestions.length;
    [...options.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', options.children[active].id);
    options.children[active].scrollIntoView({block: 'nearest'});
  });
  options.addEventListener('pointerdown', event => event.preventDefault());
  options.addEventListener('click', event => {
    const option = event.target.closest('[data-index]');
    if (option) choose(suggestions[Number(option.dataset.index)]);
  });
  return close;
}
