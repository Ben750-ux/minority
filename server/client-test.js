import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3122;
const BASE = `http://127.0.0.1:${PORT}`;

const html = readFileSync(join(ROOT, 'pages', 'lobby.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

function makeEl(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        value: '',
        placeholder: '',
        maxLength: 0,
        dataset: {},
        className: '',
        children: [],
        listeners: {},
        classList: { add() { }, remove() { }, toggle() { } },
        setAttribute() { },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        querySelectorAll() { return []; },
        focus() { }
    };
}

const registry = new Map(ids.map((id) => [id, makeEl(id)]));
registry.get('roomCode').textContent = '----';

const store = (prefix) => {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k)
    };
};

const redirects = [];
globalThis.localStorage = store('local');
globalThis.sessionStorage = store('session');
globalThis.document = {
    getElementById: (id) => registry.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(`new-${tag}`)
};
globalThis.window = {
    location: { search: '', hash: '', href: '', replace: (u) => redirects.push(u), assign: (u) => redirects.push(u) }
};
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => { } } },
    configurable: true
});
globalThis.EventSource = class {
    constructor(url) { this.url = url; }
    close() { }
};

const realFetch = globalThis.fetch;
globalThis.fetch = (path, opts) => realFetch(BASE + path, opts);

globalThis.__registry = registry;
globalThis.__redirects = redirects;

const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(process.env.TEMP || '.', 'clienttest.db') },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

process.on('uncaughtException', (err) => {
    console.log('UNCAUGHT:', err.message);
    console.log(log);
    child.kill();
    process.exit(1);
});

async function main() {
    await sleep(1200);

    // session comme le ferait pages/login.html
    const s = await realFetch(`${BASE}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' })
    }).then((r) => r.json());
    globalThis.localStorage.setItem('minority.token', s.token);
    globalThis.localStorage.setItem('minority.player', JSON.stringify(s.player));

    console.log('session simulee :', s.player.name, '/', s.token.slice(0, 8) + '...');

    process.on('unhandledRejection', (err) => {
        console.log('REJET NON GERE:', err && err.message);
    });

    try {
        await import(pathToFileURL(join(ROOT, 'js', 'lobby.js')).href);
        console.log('passe 1 : module lobby.js importe sans erreur');
    } catch (err) {
        console.log('ECHEC IMPORT:', err.constructor.name, '-', err.message);
        console.log(err.stack.split('\n').slice(0, 4).join('\n'));
    }

    await sleep(2000);
    const created = globalThis.sessionStorage.getItem('minority.room');
    console.log('passe 1 : redirect =', JSON.stringify(redirects.at(-1)), '| room =', created);

    // passe 2 : on simule le rechargement avec ?code=... dans l'URL
    redirects.length = 0;
    globalThis.window.location.search = `?code=${created}`;
    registry.get('roomCode').textContent = '----';

    try {
        await import(pathToFileURL(join(ROOT, 'js', 'lobby.js')).href + '?v=2');
        console.log('passe 2 : module lobby.js importe sans erreur');
    } catch (err) {
        console.log('ECHEC IMPORT p2:', err.constructor.name, '-', err.message);
    }

    await sleep(2000);

    console.log('');
    console.log('--- DOM apres execution ---');
    console.log('roomCode.textContent =', JSON.stringify(registry.get('roomCode').textContent),
        created ? `(attendu "${created}")` : '');
    console.log('lobbyTitle           =', JSON.stringify(registry.get('lobbyTitle').textContent));
    console.log('playerCount          =', JSON.stringify(registry.get('playerCount').textContent));
    console.log('roster enfants       =', registry.get('roster').children.length);
    console.log('start.disabled       =', registry.get('start').disabled);
    console.log('tQuestion.value      =', JSON.stringify(registry.get('tQuestion').value));
    console.log('pTarget.value        =', JSON.stringify(registry.get('pTarget').value));
    console.log('redirects            =', JSON.stringify(redirects));
    console.log('error                =', JSON.stringify(registry.get('error').textContent));
    console.log('sessionStorage room  =', globalThis.sessionStorage.getItem('minority.room'));

    const ok = registry.get('roomCode').textContent === created
        && registry.get('lobbyTitle').textContent !== ''
        && registry.get('roster').children.length === 1
        && registry.get('tQuestion').value !== '';
    console.log('');
    console.log(ok ? '=> LOBBY RENDU CORRECTEMENT' : '=> LOBBY ENCORE CASSE');

    console.log('');
    console.log('--- stdout serveur ---');
    console.log(log);
    child.kill();
}

main().catch((err) => {
    console.log('ERREUR TEST:', err.message);
    console.log(log);
    child.kill();
    process.exit(1);
});