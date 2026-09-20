const button = document.querySelector('.effects');
if (button) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let enabled = !reduced.matches;
    try {
        if (localStorage.getItem('goliath-crt') === 'off')
            enabled = false;
    }
    catch { /* Storage is optional. */ }
    const render = () => {
        document.documentElement.classList.toggle('effects-off', !enabled);
        button.setAttribute('aria-pressed', String(enabled));
        button.textContent = `CRT FX: ${enabled ? 'ON' : 'OFF'}`;
    };
    button.hidden = false;
    button.addEventListener('click', () => {
        enabled = !enabled;
        try {
            localStorage.setItem('goliath-crt', enabled ? 'on' : 'off');
        }
        catch { /* Private browsing still works. */ }
        render();
    });
    reduced.addEventListener('change', () => { if (reduced.matches) {
        enabled = false;
        render();
    } });
    render();
}
