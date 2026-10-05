import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

const html = readFileSync(join(ROOT, 'pages', 'login.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

function makeEl(id) {
    return {
        id,
        textContent: '',
        hidden: false,
        disabled: false,
        value: '',
        maxLength: 0,
        dataset: {},
        children: [],
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
            contains(c) { return this._set.has(c); }
        },
        setAttribute() { },
        get selectionStart() { return this.value.length; },
        setSelectionRange() { },
        addEventListener(type, fn) { (this._handlers ||= {})[type] = fn; },
        append(...n) { this.children.push(...n); },
        replaceChildren(...n) { this.children = n; },
        querySelector(sel) {
            if (sel === 'button') {
                if (!this._btn) this._btn = makeEl(`${this.id}-btn`);
                return this._btn;
            }
            if (sel === '.choice__title') {
                if (!this._title) this._title = makeEl(`${this.id}-title`);
                return this._title;
            }
            return null;
        },
        querySelectorAll(sel) {
            if (sel === '.steps-nav__item') {
                return ['1', '2'].map((s) => {
                    const node = makeEl(`step${s}`);
                    node.dataset.step = s;
                    return node;
                });
            }
            if (sel === '.choice__title') {
                if (!this._title) this._title = makeEl(`${this.id}-title`);
                return [this._title];
            }
            return [];
        },
        focus() { }
    };
}

const registry = new Map(ids.map((id) => [id, makeEl(id)]));

const mkStore = () => {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k)
    };
};

const redirects = [];
globalThis.localStorage = mkStore();
globalThis.sessionStorage = mkStore();
globalThis.document = {
    getElementById: (id) => registry.get(id) ?? null,
    querySelector: (s) => registry.get(s.replace('#', '')) ?? null,
    querySelectorAll: () => [],
    createElement: () => makeEl('new')
};
globalThis.window = {
    location: {
        search: '',
        set href(v) { redirects.push(v); },
        get href() { return ''; },
        replace: (u) => redirects.push(u)
    }
};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { } } }, configurable: true });
globalThis.EventSource = class { constructor() { } close() { } };

const realFetch = globalThis.fetch;
globalThis.fetch = (p, o) => realFetch(BASE + p, o);

globalThis.__r = registry;
globalThis.__redirects = redirects;

const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(process.env.TEMP || '.', 'authtest.db') },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
};

const fire = (id, type) => registry.get(id)?._handlers?.[type]?.({ preventDefault() { } });
const value = (id, v) => { registry.get(id).value = v; };
const invalid = (id) => registry.get(id).classList.contains('is-invalid');
const hidden = (id) => registry.get(id).hidden;
const shown = (id) => !registry.get(id).hidden;

async function main() {
    await sleep(1200);

    process.on('unhandledRejection', (e) => check('pas de rejet non gere', false, e?.message));

    try {
        await import(pathToFileURL(join(ROOT, 'js', 'auth.js')).href);
        check('module auth.js importe', true);
    } catch (err) {
        check('module auth.js importe', false, err.message);
        child.kill();
        return;
    }

    await sleep(300);

    check('etape 1 (pseudo) visible au depart', shown('stepPseudo') && hidden('stepChoice'));

    // pseudo vide
    value('pseudo', '   ');
    await fire('pseudoForm', 'submit');
    await sleep(150);
    check('pseudo vide -> erreur affichee', !hidden('pseudoError') && invalid('pseudo'),
        registry.get('pseudoError').textContent);

    // pseudo trop court
    value('pseudo', 'A');
    await fire('pseudoForm', 'submit');
    await sleep(150);
    check('pseudo 1 lettre -> refuse', !hidden('pseudoError'), registry.get('pseudoError').textContent);

    // pseudo valide
    value('pseudo', 'Alice');
    await fire('pseudoForm', 'submit');
    await sleep(700);
    check('pseudo valide -> passage a l etape 2', hidden('stepPseudo') && shown('stepChoice'));
    check('pseudo affiche dans le resume', registry.get('chosenName').textContent === 'Alice',
        registry.get('chosenName').textContent);
    check('jeton stocke', Boolean(globalThis.localStorage.getItem('minority.token')));

    // creation de salon
    await fire('createRoom', 'click');
    await sleep(800);
    check('creer une partie -> redirection lobby', redirects.some((u) => u.startsWith('lobby.html?code=')),
        JSON.stringify(redirects));

    // --- session existante : passage direct a l etape 2 ---
    redirects.length = 0;
    try {
        await import(pathToFileURL(join(ROOT, 'js', 'auth.js')).href + '?v=2');
    } catch (err) {
        check('reimport avec session', false, err.message);
    }
    await sleep(300);
    check('session existante -> etape 2 directe', shown('stepChoice') && hidden('stepPseudo'));
    check('pseudo repris dans le champ', registry.get('pseudo').value === 'Alice');

    // rejoindre un code invalide
    value('code', 'XY');
    await fire('joinForm', 'submit');
    await sleep(200);
    check('code incomplet -> erreur', !hidden('joinError'), registry.get('joinError').textContent);

    value('code', '@@@@');
    await fire('joinForm', 'submit');
    await sleep(200);
    check('code caracteres interdits -> erreur', !hidden('joinError'), registry.get('joinError').textContent);

    // code valide mais salon inexistant
    value('code', 'ZZZZ');
    await fire('joinForm', 'submit');
    await sleep(600);
    check('salon inexistant -> erreur 404', !hidden('joinError'), registry.get('joinError').textContent);

    // --- rejoindre un vrai salon : redirection vers la salle d'attente ---
    const s2 = await realFetch(`${BASE}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bob' })
    }).then((r) => r.json());

    const s3 = await realFetch(`${BASE}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cleo' })
    }).then((r) => r.json());

    const room = await realFetch(`${BASE}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s2.token}` },
        body: '{}'
    }).then((r) => r.json());

    await realFetch(`${BASE}/api/rooms/${room.room.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s3.token}` }
    });

    globalThis.localStorage.setItem('minority.token', s3.token);
    globalThis.localStorage.setItem('minority.player', JSON.stringify(s3.player));

    redirects.length = 0;
    value('code', room.room.code);
    console.log(`   [debug] code saisi = "${registry.get('code').value}", code cree = "${room.room.code}"`);
    await fire('joinForm', 'submit');
    await sleep(600);
    check('rejoindre -> redirection salle d attente',
        redirects.some((u) => u === `waiting.html?code=${room.room.code}`),
        JSON.stringify(redirects));
    check('la redirection contient le bon code',
        redirects.at(-1) === `waiting.html?code=${room.room.code}`,
        JSON.stringify(redirects));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n=== ${passed}/${results.length} tests passent ===`);
    if (passed !== results.length) {
        console.log(results.filter((r) => !r.ok).map((r) => `  ECHEC: ${r.label}`).join('\n'));
    }
    console.log(`\n--- serveur ---\n${log}`);
    child.kill();
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
    console.log('ERREUR:', err.message);
    console.log(err.stack.split('\n').slice(0, 6).join('\n'));
    console.log(log);
    child.kill();
    process.exit(1);
});