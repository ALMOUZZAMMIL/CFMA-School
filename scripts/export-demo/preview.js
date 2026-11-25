// Static demo preview only: forms cannot save, so they are handled here.
(function () {
  var body = document.body;
  var lang = body.getAttribute('data-pvw-lang') || 'fr';
  var role = body.getAttribute('data-pvw-role') || 'visiteur';
  var here = location.pathname.split('/').pop() || 'index.html';
  var roles = { admin: 'admin', prof: 'enseignant', parent: 'parent', eleve: 'eleve', intendant: 'intendant' };
  document.addEventListener('submit', function (e) {
    var f = e.target, action = f.getAttribute('action') || '';
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action === '/lang') {
      var next = e.submitter && e.submitter.value ? e.submitter.value : (lang === 'fr' ? 'en' : 'fr');
      location.href = '../../' + next + '/' + role + '/' + here;
    } else if (action === '/login') {
      var u = ((f.querySelector('[name=username]') || {}).value || '').toLowerCase();
      var target = 'admin';
      Object.keys(roles).forEach(function (k) { if (u.indexOf(k) !== -1) target = roles[k]; });
      location.href = '../' + target + '/index.html';
    } else if (action === '/logout') {
      location.href = '../visiteur/index.html';
    } else {
      var b = document.querySelector('.pvw-banner');
      if (b) { b.classList.add('pvw-flash'); b.scrollIntoView({ behavior: 'smooth' }); }
    }
  }, true);
})();
