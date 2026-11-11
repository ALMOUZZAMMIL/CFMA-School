// Small progressive enhancements. Every page works without JavaScript.
(function () {
  'use strict';

  // Confirm before important or destructive actions: <form data-confirm="...">, <button data-confirm="...">
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var submitter = e.submitter;
    var msg = (submitter && submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
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
