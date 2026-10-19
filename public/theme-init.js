(function() {
  try {
    var stored = localStorage.getItem('bloqueaudio_theme_v1');
    var theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var effectiveDark = theme === 'dark' || (theme === 'system' && prefersDark);
    document.documentElement.dataset.theme = effectiveDark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
})();
