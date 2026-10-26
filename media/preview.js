// Script of the rendered diff page. It runs in the VS Code webview and in the standalone page.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  const state = (vscode && vscode.getState()) || {};
  const $ = (id) => document.getElementById(id);
  const content = $('content');
  const only = $('only');
  let current = -1;
  // The elements of the shown rows, in the order of the rows that the extension sent, and their number.
  let rowEls = [];
  let shownSeq;
  // The number of rows that the last update parsed, for the tests.
  let parsedRows = 0;
  let fontsLoading = false;

  function setOnly(value) {
    only.checked = value;
    document.body.classList.toggle('only', value);
    state.only = value;
    if (vscode) vscode.setState(state);
  }

  function hunkRows() {
    // The first row of each hunk.
    const seen = new Set();
    const rows = [];
    for (const row of content.querySelectorAll('.row[data-hunk]')) {
      const h = row.dataset.hunk;
      if (!seen.has(h)) {
        seen.add(h);
        rows.push(row);
      }
    }
    return rows;
  }

  function headerHeight() {
    return document.querySelector('.bar').offsetHeight + document.querySelector('.labels').offsetHeight;
  }

  function show(index) {
    const rows = hunkRows();
    if (rows.length === 0) return;
    current = (index + rows.length) % rows.length;
    for (const r of content.querySelectorAll('.row.cur')) r.classList.remove('cur');
    const hunk = rows[current].dataset.hunk;
    for (const r of content.querySelectorAll(`.row[data-hunk="${hunk}"]`)) r.classList.add('cur');
    const target = rows[current];
    const top = () => target.getBoundingClientRect().top + window.scrollY - headerHeight() - 24;
    window.scrollTo({ top: top(), behavior: 'smooth' });
    // Rows that were not laid out yet have an estimated height (content-visibility in
    // preview.css). They get their real height as the view passes them, which moves the
    // target: correct the position when the scroll ends.
    pendingTarget = { top, until: Date.now() + 2000 };
    updatePos(rows.length);
  }

  let pendingTarget;
  window.addEventListener('scrollend', () => {
    const t = pendingTarget;
    pendingTarget = undefined;
    if (!t || Date.now() > t.until) return;
    const top = t.top();
    if (Math.abs(top - window.scrollY) > 2) window.scrollTo({ top, behavior: 'instant' });
  });

  /**
   * Scrolls to the offset that `offset()` gives, and again two frames later. Rows that come into
   * view are laid out then, and their real height can differ from the estimate. With `echo`,
   * the scroll follows the editor, so it is not sent back to the editor.
   */
  let settleTimer = 0;
  function scrollSettled(offset, echo, done) {
    const go = () => {
      if (echo) ignoreScrollUntil = Date.now() + 150;
      window.scrollTo(0, Math.max(0, offset()));
    };
    go();
    const token = ++settleTimer;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== settleTimer) return;
      go();
      if (done) done();
    }));
  }

  function step(dir) {
    const rows = hunkRows();
    if (rows.length === 0) return;
    if (current < 0) {
      // Start from the first hunk below (or above) the top of the view.
      const limit = headerHeight() + 30;
      const tops = rows.map((r) => r.getBoundingClientRect().top);
      if (dir > 0) {
        const k = tops.findIndex((t) => t > limit);
        show(k < 0 ? 0 : k);
      } else {
        let k = -1;
        tops.forEach((t, i) => { if (t < limit - 5) k = i; });
        show(k < 0 ? rows.length - 1 : k);
      }
      return;
    }
    show(current + dir);
  }

  function updatePos(total) {
    $('pos').textContent = total === 0 ? 'no changes' : current < 0 ? `${total} change${total === 1 ? '' : 's'}` : `${current + 1} / ${total}`;
  }

  // Scroll sync with the editor. Each row has the source lines of each side, for example
  // data-b="12,15". Positions between the first and last line of a row are interpolated.
  // The editor shows the new side (b), so the sync uses the b lines.
  const SIDE = 'b';
  let ignoreScrollUntil = 0;

  function range(row) {
    const v = row.dataset[SIDE];
    if (!v) return undefined;
    const [start, end] = v.split(',').map(Number);
    return [start, Math.max(end, start + 1)];
  }

  function visibleRows() {
    const rows = [];
    for (const row of content.querySelectorAll('.row')) {
      if (row.offsetHeight === 0) continue;
      const rect = row.getBoundingClientRect();
      rows.push({ row, top: rect.top + window.scrollY, height: rect.height, r: range(row) });
    }
    return rows;
  }

  /** The page offset that shows the source line `line` at the top of the view. */
  function offsetOfLine(line) {
    const rows = visibleRows().filter((x) => x.r);
    let k = -1;
    rows.forEach((x, i) => { if (x.r[0] <= line) k = i; });
    if (k < 0) return rows.length ? rows[0].top : 0;
    // Several rows can map to the same lines, for example the front matter fields. Use the first.
    while (k > 0 && rows[k - 1].r[0] === rows[k].r[0]) k--;
    const cur = rows[k];
    if (line < cur.r[1]) return cur.top + ((line - cur.r[0]) / (cur.r[1] - cur.r[0])) * cur.height;
    // The line is in the gap after this block, for example a blank line.
    const end = cur.top + cur.height;
    const next = rows[k + 1];
    if (!next) return end;
    return end + ((line - cur.r[1]) / Math.max(1, next.r[0] - cur.r[1])) * (next.top - end);
  }

  /** The source line at the top of the view. */
  function lineAtTop() {
    const y = window.scrollY + headerHeight();
    const rows = visibleRows();
    let k = rows.findIndex((x) => y < x.top + x.height);
    if (k < 0) k = rows.length - 1;
    if (k < 0) return 0;
    const cur = rows[k];
    if (cur.r) return cur.r[0] + Math.max(0, Math.min(1, (y - cur.top) / cur.height)) * (cur.r[1] - cur.r[0]);
    // A placeholder row has no lines on this side: use the nearest row that has.
    for (let i = k - 1; i >= 0; i--) if (rows[i].r) return rows[i].r[1];
    for (let i = k + 1; i < rows.length; i++) if (rows[i].r) return rows[i].r[0];
    return 0;
  }

  function scrollToLine(line) {
    const synced = () => {
      if (vscode) vscode.postMessage({ type: 'synced', top: window.scrollY });
    };
    scrollSettled(() => offsetOfLine(line) - headerHeight(), true, synced);
    synced();
  }

  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (!vscode || Date.now() < ignoreScrollUntil || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      vscode.postMessage({ type: 'reveal', line: lineAtTop() });
    });
  });

  /**
   * Shows the rows of an update. A row is HTML, or the index of an equal row that is shown
   * already: that element stays in the page, with its layout, and only the new rows are parsed.
   */
  function setRows(rows, patch) {
    const old = patch ? rowEls : [];
    const fresh = rows.filter((r) => typeof r === 'string');
    const tpl = document.createElement('template');
    tpl.innerHTML = fresh.join('');
    const made = [...tpl.content.children];
    parsedRows = made.length;
    let k = 0;
    const els = rows.map((r) => (typeof r === 'string' ? made[k++] : old[r]));
    if (!patch) content.replaceChildren();
    for (const n of content.querySelectorAll(':scope > .empty, :scope > .error')) n.remove();
    // Insert or move only where the order differs, then remove the rows that are gone.
    let cursor = content.firstChild;
    for (const el of els) {
      if (el === cursor) cursor = cursor.nextSibling;
      else content.insertBefore(el, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    rowEls = els;
  }

  function update(msg) {
    $('title').textContent = msg.title;
    $('label-a').textContent = msg.labelA;
    $('label-b').textContent = msg.labelB;
    const parts = [];
    if (msg.changed) parts.push(`${msg.changed} changed`);
    if (msg.added) parts.push(`${msg.added} added`);
    if (msg.removed) parts.push(`${msg.removed} removed`);
    $('stats').textContent = parts.length ? parts.join(', ') + ' blocks' : '';
    if (msg.base !== undefined && msg.base !== shownSeq) {
      // The patch refers to rows that this page does not have: ask for all rows.
      if (vscode) vscode.postMessage({ type: 'resync' });
      return;
    }
    const y = window.scrollY;
    if (msg.error) {
      content.replaceChildren();
      rowEls = [];
      shownSeq = undefined;
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = msg.error;
      content.appendChild(div);
    } else {
      if (msg.rows) setRows(msg.rows, msg.base !== undefined);
      else content.innerHTML = msg.html;
      shownSeq = msg.seq;
      if (msg.hunks === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = 'The rendered documents are the same.';
        content.prepend(div);
      }
    }
    for (const r of content.querySelectorAll('.row.cur')) r.classList.remove('cur');
    // Rows off screen are not laid out, so the browser would load the KaTeX fonts only when a
    // formula scrolls into view, and show it in a fallback font first. Load the main ones now.
    if (!fontsLoading && content.querySelector('.katex')) {
      fontsLoading = true;
      for (const font of ['1em KaTeX_Main', '1em KaTeX_Math']) document.fonts.load(font).catch(() => {});
    }
    current = -1;
    updatePos(msg.hunks);
    ignoreScrollUntil = Date.now() + 150;
    window.scrollTo(0, msg.reset ? 0 : y);
    if (vscode) {
      // Facts about the page for the integration tests.
      const row = content.querySelector('.row');
      const katex = content.querySelector('.katex');
      document.fonts.ready.then(() => {
        vscode.postMessage({
          type: 'rendered',
          rows: content.querySelectorAll('.row').length,
          parsed: parsedRows,
          lastRow: rowEls.length ? rowEls[rowEls.length - 1].textContent.slice(-200) : '',
          grid: row ? getComputedStyle(row).display === 'grid' : false,
          katexFont: katex ? getComputedStyle(katex).fontFamily : '',
          fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
        });
      });
    }
  }

  $('next').addEventListener('click', () => step(1));
  $('prev').addEventListener('click', () => step(-1));
  only.addEventListener('change', () => setOnly(only.checked));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'j') step(1);
    else if (e.key === 'p' || e.key === 'k') step(-1);
    else if (e.key === 'o') setOnly(!only.checked);
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !vscode) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) return;
    e.preventDefault();
    vscode.postMessage({ type: 'open', href });
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'update') update(msg);
    else if (msg.type === 'scroll') scrollToLine(msg.line);
    // Only the tests send this: a scroll as if the reader made it, to an offset or to the
    // first row that contains a text.
    else if (msg.type === 'testScroll') {
      const row = msg.text && [...content.querySelectorAll('.row')].find((r) => r.textContent.includes(msg.text));
      scrollSettled(() => (row ? row.getBoundingClientRect().top + window.scrollY - headerHeight() : msg.y), false);
    }
  });

  setOnly(!!state.only);
  if (window.__MDIFF_INITIAL__) update(window.__MDIFF_INITIAL__);
  if (vscode) vscode.postMessage({ type: 'ready' });
})();
