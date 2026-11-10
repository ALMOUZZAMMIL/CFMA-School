// Static preview: no server, so forms are simulated.
(function () {
  var root = document.body.getAttribute('data-root') || '';
  var ACCOUNTS = { 'demo.admin': 'admin', 'demo.prof.maths': 'enseignant', 'demo.prof.lettres': 'enseignant', 'demo.parent': 'parent', 'demo.eleve': 'eleve' };
  function note(msg) {
    var n = document.getElementById('pvw-note');
    if (!n) { n = document.createElement('div'); n.id = 'pvw-note'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.textContent = msg; n.className = 'show';
    clearTimeout(note.t); note.t = setTimeout(function () { n.className = ''; }, 4000);
  }
  document.addEventListener('submit', function (e) {
    var f = e.target; var action = f.getAttribute('action') || '';
    e.preventDefault(); e.stopImmediatePropagation();
    if (/\/login$/.test(action)) {
      var u = (f.querySelector('[name=username]') || {}).value || '';
      var role = ACCOUNTS[u.trim().toLowerCase()];
      if (role) { location.href = root + role + '/index.html'; return; }
      note('Aperçu : utilisez demo.admin, demo.prof.maths, demo.parent ou demo.eleve (n’importe quel mot de passe).'); return;
    }
    if (/\/logout$/.test(action)) { location.href = root + 'visiteur/index.html'; return; }
    if (/\/(register|forgot-password)$/.test(action)) { location.href = root + 'visiteur/' + (/register/.test(action) ? 'register' : 'forgot_password') + '.html#'; note('Aperçu : dans la vraie application, la demande est enregistrée pour l’administration.'); return; }
    note('Aperçu : les formulaires ne sont pas enregistrés dans cette démonstration.');
  }, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-unavailable]');
    if (a) { e.preventDefault(); note('Aperçu : cette page n’est pas incluse dans la démonstration.'); }
  });
})();
