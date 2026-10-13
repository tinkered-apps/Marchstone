/* privacy.js: use the same theme and language as the app, before the first paint,
 * and save a change made here back to the app's settings. */
(function () {
  const WORDS = {
    en: { title: 'Data and privacy · Marchstone', h1: 'Privacy', back: 'My areas',
          settings: 'Settings', language: 'Language',
          auto: 'Theme: follows your system', light: 'Theme: day', dark: 'Theme: night' },
    pl: { title: 'Dane i prywatność · Marchstone', h1: 'Prywatność', back: 'Obszary',
          settings: 'Ustawienia', language: 'Język',
          auto: 'Motyw: jak w systemie', light: 'Motyw: jasny', dark: 'Motyw: ciemny' },
  };
  let theme = 'auto';
  let lang = 'en';
  try {
    const s = JSON.parse(localStorage.getItem('fb.settings'));
    if (s && (s.theme === 'light' || s.theme === 'dark')) theme = s.theme;
    if (s && s.lang in WORDS) lang = s.lang;
  } catch (e) { /* no settings yet, or storage blocked: follow the phone, in English */ }
  document.documentElement.lang = lang;

  function save(key, value) {
    try {
      const settings = JSON.parse(localStorage.getItem('fb.settings')) || {};
      settings[key] = value;
      localStorage.setItem('fb.settings', JSON.stringify(settings));
    } catch (e) { /* storage blocked: keep the choice on this page */ }
  }

  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    const button = document.getElementById('btnTheme');
    if (!button) return;
    const label = WORDS[lang][theme];
    button.setAttribute('aria-label', label);
    button.title = label;
    button.querySelector('use').setAttribute('href', '#i-theme-' + theme);
  }

  function applyLang() {
    const w = WORDS[lang];
    document.documentElement.lang = lang;
    document.title = w.title;
    document.getElementById('title').textContent = w.h1;
    document.getElementById('lnkBack').setAttribute('aria-label', w.back);
    const settings = document.getElementById('btnSettings');
    settings.setAttribute('aria-label', w.settings);
    settings.querySelector('.icon-word').textContent = w.settings;
    const group = document.getElementById('langSwitch');
    group.setAttribute('aria-label', w.language);
    group.querySelectorAll('[data-lang]').forEach((b) => {
      const on = b.dataset.lang === lang;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-locale]').forEach((a) => { a.hidden = a.dataset.locale !== lang; });
    applyTheme();
  }

  function pickLang(code) {
    if (!(code in WORDS) || code === lang) return;
    lang = code;
    save('lang', lang);
    applyLang();
  }

  applyTheme();
  document.addEventListener('DOMContentLoaded', () => {
    applyLang();
    document.getElementById('btnTheme').onclick = () => {
      const themes = ['auto', 'light', 'dark'];
      theme = themes[(themes.indexOf(theme) + 1) % themes.length];
      save('theme', theme);
      applyTheme();
    };
    const group = document.getElementById('langSwitch');
    group.querySelectorAll('[data-lang]').forEach((b) => {
      b.onclick = () => pickLang(b.dataset.lang);
    });
    // A radio group is one tab stop; the arrow keys move the choice inside it.
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      pickLang(lang === 'en' ? 'pl' : 'en');
      group.querySelector('[data-lang="' + lang + '"]').focus();
    });
  });
})();
