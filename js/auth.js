import { ensureSession, api, getSession } from './net.js';

const authForm = document.getElementById('authForm');
const joinForm = document.getElementById('joinForm');
const errorEl = document.getElementById('error');
const joinErrorEl = document.getElementById('joinError');
const codeInput = document.getElementById('code');

const existing = getSession();
if (existing) {
    window.location.replace('lobby.html');
}

function show(el, message) {
    el.textContent = message;
    el.hidden = false;
}

authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const name = document.getElementById('pseudo').value.trim();
    if (!name) {
        show(errorEl, 'Choisis un pseudo.');
        return;
    }

    const button = authForm.querySelector('button');
    button.disabled = true;
    button.textContent = 'Connexion…';

    try {
        await ensureSession(name);
        window.location.href = 'lobby.html';
    } catch (err) {
        show(errorEl, err.message);
        button.disabled = false;
        button.textContent = 'Commencer';
    }
});

joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    joinErrorEl.hidden = true;

    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
        show(joinErrorEl, 'Le code fait 4 caractères.');
        return;
    }

    const button = joinForm.querySelector('button');
    button.disabled = true;
    button.textContent = '…';

    try {
        let session = getSession();
        if (!session) {
            show(joinErrorEl, 'Connecte-toi d\'abord avec ton pseudo.');
            button.disabled = false;
            button.textContent = 'Rejoindre';
            return;
        }

        await api(`/api/rooms/${code}/join`, { method: 'POST' });
        sessionStorage.setItem('minority.room', code);
        window.location.href = 'game.html';
    } catch (err) {
        show(joinErrorEl, err.message);
        button.disabled = false;
        button.textContent = 'Rejoindre';
    }
});

codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});