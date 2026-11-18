(function () {
  'use strict';
  // Confirmation on destructive buttons
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-confirm]');
    if (b && !window.confirm(b.getAttribute('data-confirm'))) e.preventDefault();
    var c = e.target.closest('[data-copy]');
    if (c) {
      var t = c.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { c.textContent = 'Link copied. In Outlook: Add calendar › From internet'; });
      else window.prompt('Copy this link', t);
    }
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
    if (e.key === 'Escape') { var x = document.querySelector('[data-close]'); if (x) window.location.href = x.href; }
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
