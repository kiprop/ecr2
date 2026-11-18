(function () {
  'use strict';
  // In-page confirmation for important actions (no browser pop-ups)
  var modal = document.getElementById('confirm-modal'); var pending = null; var lastFocus = null;
  function closeModal() { if (!modal) return; modal.hidden = true; pending = null; if (lastFocus) lastFocus.focus(); }
  if (modal) {
    modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    modal.querySelector('[data-ok]').addEventListener('click', function () {
      var b = pending; closeModal(); if (!b) return;
      b.setAttribute('data-confirmed', '1');
      if (b.form && b.form.requestSubmit) b.form.requestSubmit(b); else b.click();
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-confirm]');
    if (b && modal && !b.hasAttribute('data-confirmed')) {
      e.preventDefault(); pending = b; lastFocus = b;
      document.getElementById('confirm-text').textContent = b.getAttribute('data-confirm');
      modal.querySelector('[data-ok]').textContent = b.getAttribute('data-ok-label') || 'Continue';
      modal.querySelector('[data-ok]').className = 'btn ' + (b.classList.contains('btn-ret') ? 'btn-ret' : 'btn-pri');
      modal.hidden = false; modal.querySelector('[data-ok]').focus();
      return;
    }
    // close open menus when clicking elsewhere
    document.querySelectorAll('details[data-menu][open]').forEach(function (m) { if (!m.contains(e.target)) m.removeAttribute('open'); });
    var c = e.target.closest('[data-copy]');
    if (c) {
      var t = c.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { c.textContent = 'Link copied. In Outlook: Add calendar › From internet'; });
      else window.prompt('Copy this link', t);
    }
  });
  document.querySelectorAll('details[data-menu]').forEach(function (m) {
    m.addEventListener('toggle', function () { if (m.open) document.querySelectorAll('details[data-menu][open]').forEach(function (o) { if (o !== m) o.removeAttribute('open'); }); });
  });
  // Country switcher and change-form country picker
  document.addEventListener('change', function (e) {
    var g = e.target.getAttribute('data-goto');
    if (g) window.location.href = g + encodeURIComponent(e.target.value);
    var r = e.target.getAttribute('data-reload');
    if (r) window.location.href = r + encodeURIComponent(e.target.value);
  });
  // Escape closes the drawer
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (modal && !modal.hidden) { closeModal(); return; }
    var open = document.querySelectorAll('details[data-menu][open]');
    if (open.length) { open.forEach(function (m) { m.removeAttribute('open'); }); return; }
    var x = document.querySelector('[data-close]'); if (x) window.location.href = x.href;
  });
  // Directory search on the invite page
  var q = document.getElementById('dir-q');
  if (q) {
    var out = document.getElementById('dir-results'); var timer;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (q.value.trim().length < 2) { out.textContent = ''; return; }
        fetch(q.getAttribute('data-dir') + '?q=' + encodeURIComponent(q.value), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (list) {
          out.textContent = '';
          list.forEach(function (p) {
            var b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
            var s = document.createElement('span'); var n = document.createElement('b'); n.textContent = p.name; n.style.display = 'block';
            var m = document.createElement('span'); m.className = 'muted small'; m.textContent = (p.title ? p.title + ' · ' : '') + p.email;
            s.appendChild(n); s.appendChild(m); b.appendChild(s);
            b.addEventListener('click', function () { document.getElementById('f-name').value = p.name; document.getElementById('f-email').value = p.email; document.getElementById('f-title').value = p.title || ''; out.textContent = ''; });
            out.appendChild(b);
          });
        });
      }, 250);
    });
  }
})();
