// Login / registration screen.
import { $, el } from './dom.js';
import { api, token } from './api.js';

export function mountAuth(mode = 'login') {
  const app = document.getElementById('app');
  const render = () => {
    const reg = mode === 'register';
    app.innerHTML = '';
    const page = el(`<div class="auth-page"><form class="auth-card" novalidate>
      <img class="logo" src="/icons/logo.png" alt="Yapper">
      <h1>${reg ? 'Create an account' : 'Welcome back!'}</h1>
      <p class="sub">${reg ? 'Join Yapper — everything is free, forever.' : "We're so excited to see you again!"}</p>
      <div class="form-error" hidden></div>
      ${reg ? `
        <div class="field"><label for="f-email">Email <span class="faint">(optional)</span></label><input class="input" id="f-email" name="email" type="email" autocomplete="email"></div>
        <div class="field"><label for="f-dn">Display Name</label><input class="input" id="f-dn" name="display_name" maxlength="32" autocomplete="nickname"></div>
        <div class="field"><label for="f-user">Username</label><input class="input" id="f-user" name="username" required maxlength="32" autocapitalize="none" autocomplete="username" spellcheck="false">
          <div class="hint">Letters, numbers, underscores and periods only.</div></div>` : `
        <div class="field"><label for="f-user">Username or Email</label><input class="input" id="f-user" name="username" required autocapitalize="none" autocomplete="username" spellcheck="false"></div>`}
      <div class="field"><label for="f-pw">Password</label><input class="input" id="f-pw" name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></div>
      <button class="btn block" type="submit" style="min-height:44px;font-size:1rem">${reg ? 'Continue' : 'Log In'}</button>
      <div class="switch-link">${reg ? 'Already have an account? <button type="button" data-switch>Log In</button>' : 'Need an account? <button type="button" data-switch>Register</button>'}</div>
    </form></div>`);
    app.append(page);
    const form = $('form', page);
    const errBox = $('.form-error', page);
    $('[data-switch]', page).onclick = () => {
      mode = reg ? 'login' : 'register';
      history.replaceState({}, '', reg ? '/login' : '/register');
      render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const data = Object.fromEntries(new FormData(form));
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        const r = await api('POST', reg ? '/auth/register' : '/auth/login', data);
        token.set(r.token);
        location.href = sessionStorage.getItem('yapper_after_login') || '/channels/@me';
        sessionStorage.removeItem('yapper_after_login');
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        btn.disabled = false;
      }
    };
    setTimeout(() => $('input', form)?.focus(), 30);
  };
  render();
}
