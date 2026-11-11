// Small progressive enhancements. Every page works without JavaScript.
(function () {
  'use strict';

  // Confirm before important or destructive actions: <form data-confirm="...">, <button data-confirm="...">
  // Shown in the portal's own dialog where the browser supports <dialog>, otherwise the browser's confirm.
  var dialogSupported = typeof window.HTMLDialogElement === 'function';
  function askConfirm(msg, onYes) {
    var body = document.body;
    var dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.setAttribute('aria-labelledby', 'confirm-msg');
    var inner = document.createElement('div');
    inner.className = 'dialog-body';
    var icon = document.createElement('span');
    icon.className = 'dialog-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';
    var p = document.createElement('p');
    p.id = 'confirm-msg';
    p.textContent = msg;
    inner.appendChild(icon); inner.appendChild(p);
    var foot = document.createElement('div');
    foot.className = 'dialog-foot';
    var no = document.createElement('button');
    no.type = 'button'; no.className = 'btn'; no.textContent = body.getAttribute('data-confirm-cancel') || 'Cancel';
    var yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn btn-primary'; yes.textContent = body.getAttribute('data-confirm-ok') || 'OK';
    foot.appendChild(no); foot.appendChild(yes);
    dlg.appendChild(inner); dlg.appendChild(foot);
    body.appendChild(dlg);
    var done = function () { dlg.close(); dlg.remove(); };
    no.addEventListener('click', done);
    dlg.addEventListener('cancel', function () { setTimeout(function () { if (dlg.isConnected) dlg.remove(); }, 0); });
    yes.addEventListener('click', function () { done(); onYes(); });
    dlg.showModal();
    no.focus();
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var submitter = e.submitter;
    var msg = (submitter && submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (msg && form.dataset.confirmed !== '1') {
      if (!dialogSupported || !form.requestSubmit) {
        if (!window.confirm(msg)) { e.preventDefault(); return; }
      } else {
        e.preventDefault();
        askConfirm(msg, function () {
          form.dataset.confirmed = '1';
          if (submitter && submitter.form === form) form.requestSubmit(submitter); else form.requestSubmit();
          delete form.dataset.confirmed;
        });
        return;
      }
    }
    // Prevent double submission on slow connections (server also rejects duplicates).
    if (form.hasAttribute('data-once')) {
      if (form.dataset.sent) { e.preventDefault(); return; }
      form.dataset.sent = '1';
      // Loading state: <form data-loading> with <button data-loading-text="...">
      if (form.hasAttribute('data-loading')) {
        form.setAttribute('aria-busy', 'true');
        form.querySelectorAll('[data-loading-text]').forEach(function (b) {
          b.dataset.label = b.textContent;
          b.textContent = b.getAttribute('data-loading-text');
        });
      }
      setTimeout(function () {
        form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      }, 0);
    }
  });

  // Phone menu: works without JavaScript through the #menu link; with it, no history entry is added
  // and Escape closes it. The account menu closes when clicking elsewhere.
  var menu = document.getElementById('menu');
  function setMenu(open) {
    if (!menu) return;
    menu.classList.toggle('open', open);
    if (open) { var first = menu.querySelector('.sb-item'); if (first) first.focus(); }
    if (!open && location.hash === '#menu') history.replaceState(null, '', location.pathname + location.search);
  }
  document.addEventListener('click', function (e) {
    if (menu) {
      if (e.target.closest('a[href="#menu"]')) { e.preventDefault(); setMenu(true); return; }
      if (e.target.closest('.sb-close, .sb-backdrop')) { e.preventDefault(); setMenu(false); return; }
    }
    document.querySelectorAll('details.account[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (menu && (menu.classList.contains('open') || location.hash === '#menu')) setMenu(false);
    document.querySelectorAll('details.account[open]').forEach(function (d) { d.removeAttribute('open'); d.querySelector('summary').focus(); });
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-print]');
    if (t) { e.preventDefault(); window.print(); }
    // Show / hide password: <button data-pw-toggle="input-id" data-show="..." data-hide="...">
    var pw = e.target.closest('[data-pw-toggle]');
    if (pw) {
      var input = document.getElementById(pw.getAttribute('data-pw-toggle'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      pw.setAttribute('aria-pressed', String(show));
      pw.textContent = pw.getAttribute(show ? 'data-hide' : 'data-show');
      input.focus();
    }
    var all = e.target.closest('[data-all-present]');
    if (all) {
      document.querySelectorAll('.att-present input[type=radio]').forEach(function (r) { r.checked = true; });
      updateSummary();
    }
  });

  // Show/hide parts of a form depending on a radio choice: data-show-when="status=missed,cancelled"
  function applyShowWhen() {
    document.querySelectorAll('[data-show-when]').forEach(function (el) {
      var parts = el.getAttribute('data-show-when').split('=');
      var name = parts[0];
      var values = parts[1].split(',');
      var checked = document.querySelector('input[name="' + name + '"]:checked');
      el.hidden = !(checked && values.indexOf(checked.value) >= 0);
    });
  }
  document.addEventListener('change', function (e) {
    if (e.target.type === 'radio') { applyShowWhen(); updateSummary(); }
  });

  // Live count on the attendance page.
  function updateSummary() {
    var box = document.querySelector('[data-att-summary]');
    if (!box) return;
    var counts = { present: 0, absent: 0, late: 0, excused: 0 };
    document.querySelectorAll('.att-choices input:checked').forEach(function (r) { counts[r.value]++; });
    var labels = {};
    document.querySelectorAll('.att-row:first-child .att-opt').forEach(function (l) {
      var input = l.querySelector('input');
      labels[input.value] = l.textContent.replace(/^\s*\S+\s*/, '').trim();
    });
    box.textContent = Object.keys(counts).map(function (k) { return (labels[k] || k) + ': ' + counts[k]; }).join(' · ');
  }

  // Tell the user when they lose their connection.
  function net() {
    var el = document.getElementById('net-status');
    if (el) el.hidden = navigator.onLine;
  }
  window.addEventListener('online', net);
  window.addEventListener('offline', net);

  // Coming back with the browser's Back button: make forms usable again.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[data-sent]').forEach(function (form) {
      delete form.dataset.sent;
      form.removeAttribute('aria-busy');
      form.querySelectorAll('button').forEach(function (b) { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; });
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-pw-toggle]').forEach(function (b) { b.hidden = false; });
    applyShowWhen(); updateSummary(); net();
  });

  // Warning before an idle sign-out, and recovery after one. Nothing typed is stored in the
  // browser: the form simply stays on the page, and after signing in again in another tab its
  // security token is refreshed so it can be saved. Only same-origin requests are made.
  var box = document.getElementById('session-warning');
  if (box && window.fetch) {
    var userId = box.getAttribute('data-user');
    var timer = null;
    var show = function (which) {
      box.hidden = !which;
      box.querySelectorAll('[data-session-msg]').forEach(function (m) { m.hidden = m.getAttribute('data-session-msg') !== which; });
      box.querySelector('[data-session-action="stay"]').hidden = which !== 'warning';
      box.querySelector('[data-session-action="signin"]').hidden = which !== 'ended';
    };
    var token = function () { var i = document.querySelector('input[name="_csrf"]'); return i ? i.value : ''; };
    var schedule = function (seconds) { clearTimeout(timer); timer = setTimeout(check, Math.max(15, seconds) * 1000); };
    var apply = function (st) {
      if (!st.signedIn || String(st.user) !== userId) { box.dataset.state = 'ended'; show('ended'); schedule(15); return; }
      if (box.dataset.state === 'ended') {
        // Signed in again (same person): refresh the form tokens so this page can be saved.
        document.querySelectorAll('input[name="_csrf"]').forEach(function (i) { i.value = st.csrf; });
        show('restored');
        box.dataset.state = '';
        setTimeout(function () { if (box.dataset.state !== 'ended') show(null); }, 8000);
      } else if (st.remainingSeconds <= 150) show('warning');
      else show(null);
      schedule(st.remainingSeconds <= 150 ? st.remainingSeconds + 5 : st.remainingSeconds - 120);
    };
    var check = function () {
      fetch('/session/status', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(apply)
        .catch(function () { schedule(60); });
    };
    box.querySelector('[data-session-action="stay"]').addEventListener('click', function () {
      fetch('/session/keepalive', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': token() } })
        .then(function (r) { return r.json(); }).then(apply).catch(function () { schedule(30); });
    });
    check();
  }
})();
