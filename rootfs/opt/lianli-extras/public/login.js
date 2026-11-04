'use strict';

const element = (id) => document.getElementById(id);
const FORGOT = 'Forgot it? In Unraid, edit this container, click Show more settings, set Reset dashboard password to yes and click Apply. Then come back here to create a new one.';
const RESET_ON = 'Reset dashboard password is still set to yes in the container settings. Set it back to no when you can, so it works next time you need it.';

async function start() {
  const { setup, resetOn } = await (await fetch('/api/auth')).json();
  element('title').textContent = setup ? 'Create a password' : 'Sign in';
  element('intro').textContent = setup ? 'Choose a password for this dashboard, at least 8 characters. You\'ll use it on every device.' : 'Enter your dashboard password.';
  element('submit').textContent = setup ? 'Create password' : 'Sign in';
  element('help').textContent = setup ? (resetOn ? RESET_ON : '') : FORGOT;
  element('confirmRow').hidden = !setup;
  element('confirm').required = setup;
  element('password').autocomplete = setup ? 'new-password' : 'current-password';
  element('form').hidden = false;
  element('password').focus();

  element('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const show = (message) => {
      element('error').textContent = message;
      element('error').hidden = false;
    };
    const password = element('password').value;
    if (setup && password !== element('confirm').value) return show('The passwords don\'t match');
    element('submit').disabled = true;
    try {
      const response = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' },
        body: JSON.stringify({ password }),
      });
      if (response.ok) return window.location.replace('/');
      show((await response.json()).error);
    } catch {
      show('Can\'t reach the dashboard');
    }
    element('submit').disabled = false;
  });
}

start();
