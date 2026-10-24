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

// Progressive enhancement: without JS, the complete journal remains visible.
const intro = document.querySelector('.portal-intro');
const cabinet = document.querySelector('.cabinet');
const replay = document.querySelector('.replay-intro');
if (intro && cabinet && replay) {
    const trigger = intro.querySelector('.orb-trigger');
    const skip = intro.querySelector('.skip-intro');
    const scene = intro.querySelector('.crystal-scene');
    let revealing = false;
    let animations = [];
    const finish = () => {
        intro.hidden = true;
        cabinet.inert = false;
        document.body.classList.remove('portal-open', 'portal-revealing');
        animations.forEach(animation => animation.cancel());
        animations = [];
        revealing = false;
        try { sessionStorage.setItem('goliath-crystal-entered', 'yes'); } catch { /* Optional storage. */ }
        document.querySelector('#main').focus({ preventScroll: true });
    };
    const reveal = (animate = true) => {
        if (revealing) return;
        revealing = true;
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!animate || reduced || document.documentElement.classList.contains('effects-off') || !cabinet.animate) {
            finish();
            return;
        }
        document.body.classList.add('portal-revealing');
        const orb = trigger.getBoundingClientRect();
        const frame = cabinet.getBoundingClientRect();
        const x = orb.left + orb.width / 2 - frame.left;
        const y = orb.top + orb.height / 2 - frame.top;
        const radius = Math.hypot(Math.max(x, frame.width - x), Math.max(y, frame.height - y));
        animations = [
            cabinet.animate([
                { clipPath: `circle(0px at ${x}px ${y}px)`, opacity: 0.2 },
                { clipPath: `circle(${radius}px at ${x}px ${y}px)`, opacity: 1 },
            ], { duration: 1100, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' }),
            scene.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(4.5)', opacity: 0 }], { duration: 850, easing: 'ease-in', fill: 'both' }),
            intro.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000, easing: 'ease-in', fill: 'both' }),
        ];
        Promise.all(animations.map(animation => animation.finished)).then(finish).catch(finish);
    };
    const open = () => {
        if (revealing) return;
        window.scrollTo(0, 0);
        intro.hidden = false;
        cabinet.inert = true;
        document.body.classList.add('portal-open');
        trigger.focus({ preventScroll: true });
    };
    trigger.addEventListener('click', () => reveal());
    skip.addEventListener('click', () => reveal(false));
    intro.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); reveal(false); }
        if (event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === trigger ? skip : trigger).focus();
        }
    });
    replay.hidden = false;
    replay.addEventListener('click', open);
    let entered = false;
    try { entered = sessionStorage.getItem('goliath-crystal-entered') === 'yes'; } catch { /* Optional storage. */ }
    if (!entered && !location.hash) open();
}
