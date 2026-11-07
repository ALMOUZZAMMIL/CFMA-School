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
      setTimeout(function () {
        form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      }, 0);
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-print]');
    if (t) { e.preventDefault(); window.print(); }
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

  document.addEventListener('DOMContentLoaded', function () { applyShowWhen(); updateSummary(); net(); });
})();
