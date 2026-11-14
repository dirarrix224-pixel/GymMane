(() => {
  const ar = (navigator.language || '').toLowerCase().startsWith('ar');
  const T = ar
    ? { sub: 'سجّل الدخول للمتابعة', u: 'اسم المستخدم', p: 'كلمة المرور', b: 'دخول',
        bad: 'اسم المستخدم أو كلمة المرور غير صحيحة', lim: 'محاولات كثيرة، حاول لاحقًا', net: 'تعذّر الاتصال بالخادم' }
    : { sub: 'Sign in to continue', u: 'Username', p: 'Password', b: 'Sign in',
        bad: 'Wrong username or password', lim: 'Too many attempts, try again later', net: 'Cannot reach the server' };
  document.documentElement.lang = ar ? 'ar' : 'en';
  document.documentElement.dir = ar ? 'rtl' : 'ltr';
  const $ = (id) => document.getElementById(id);
  $('sub').textContent = T.sub; $('lu').textContent = T.u; $('lp').textContent = T.p; $('b').textContent = T.b;

  const go = () => { location.replace('/'); };
  if (new URLSearchParams(location.search).has('logout')) {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  } else {
    fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => { if (r.ok) go(); }).catch(() => {});
  }
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').textContent = ''; $('b').disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: $('u').value, password: $('p').value }),
      });
      if (r.ok) return go();
      $('err').textContent = r.status === 429 ? T.lim : T.bad;
    } catch { $('err').textContent = T.net; }
    $('b').disabled = false;
  });
})();
