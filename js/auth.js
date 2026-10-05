import { ensureSession, api, getSession } from './net.js';

const el = {
    steps: document.getElementById('stepsNav'),
    pseudoStep: document.getElementById('stepPseudo'),
    choiceStep: document.getElementById('stepChoice'),
    pseudoForm: document.getElementById('pseudoForm'),
    pseudo: document.getElementById('pseudo'),
    pseudoError: document.getElementById('pseudoError'),
    chosenName: document.getElementById('chosenName'),
    changeName: document.getElementById('changeName'),
    createRoom: document.getElementById('createRoom'),
    joinForm: document.getElementById('joinForm'),
    code: document.getElementById('code'),
    joinError: document.getElementById('joinError')
};

const MIN_PSEUDO = 2;
const MAX_PSEUDO = 16;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function showError(node, input, message) {
    node.textContent = message;
    node.hidden = false;
    input.classList.add('is-invalid');
}

function clearError(node, input) {
    node.hidden = true;
    node.textContent = '';
    input.classList.remove('is-invalid');
}

function setStep(n) {
    el.pseudoStep.hidden = n !== 1;
    el.choiceStep.hidden = n !== 2;

    el.steps.querySelectorAll('.steps-nav__item').forEach((item) => {
        item.classList.toggle('is-current', Number(item.dataset.step) === n);
    });

    if (n === 1) {
        el.pseudo.focus();
    } else {
        el.code.focus();
    }
}

function goToChoice(name) {
    el.chosenName.textContent = name;
    setStep(2);
}

el.pseudo.addEventListener('input', () => {
    el.pseudo.value = el.pseudo.value.replace(/\s+/g, ' ').slice(0, MAX_PSEUDO);
    if (el.pseudoError.hidden === false) {
        clearError(el.pseudoError, el.pseudo);
    }
});

el.pseudoForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = el.pseudo.value.trim();

    if (!name) {
        showError(el.pseudoError, el.pseudo, 'Il faut un pseudo pour jouer.');
        return;
    }
    if (name.length < MIN_PSEUDO) {
        showError(el.pseudoError, el.pseudo, `Minimum ${MIN_PSEUDO} caractères.`);
        return;
    }

    const button = el.pseudoForm.querySelector('button');
    button.disabled = true;
    button.textContent = 'Connexion…';

    try {
        await ensureSession(name);
        goToChoice(name);
    } catch (err) {
        showError(el.pseudoError, el.pseudo, err.message);
    } finally {
        button.disabled = false;
        button.textContent = 'Continuer';
    }
});

el.changeName.addEventListener('click', () => {
    el.pseudo.value = '';
    setStep(1);
});

el.createRoom.addEventListener('click', async () => {
    el.createRoom.disabled = true;
    const title = el.createRoom.querySelector('.choice__title');
    const original = title.textContent;
    title.textContent = 'Création…';

    try {
        const created = await api('/api/rooms', { method: 'POST', body: { config: {} } });
        sessionStorage.setItem('minority.room', created.room.code);
        window.location.href = `lobby.html?code=${created.room.code}`;
    } catch (err) {
        el.createRoom.disabled = false;
        title.textContent = original;
        showError(el.joinError, el.code, err.message);
    }
});

el.code.addEventListener('input', () => {
    const cleaned = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const caretAtEnd = el.code.selectionStart === el.code.value.length;
    el.code.value = cleaned;
    if (caretAtEnd) {
        el.code.setSelectionRange(cleaned.length, cleaned.length);
    }
    if (el.joinError.hidden === false) {
        clearError(el.joinError, el.code);
    }
    const button = el.joinForm.querySelector('button');
    button.disabled = cleaned.length !== 4;
});

el.joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const code = el.code.value.trim().toUpperCase();

    if (!code) {
        showError(el.joinError, el.code, 'Saisis le code à 4 caractères du maître de jeu.');
        return;
    }
    if (code.length !== 4 || ![...code].every((c) => alphabet.includes(c))) {
        showError(el.joinError, el.code, 'Ce code est invalide.');
        return;
    }

    const button = el.joinForm.querySelector('button');
    button.disabled = true;
    button.textContent = '…';

    try {
        await api(`/api/rooms/${code}/join`, { method: 'POST' });
        sessionStorage.setItem('minority.room', code);
        window.location.href = `waiting.html?code=${code}`;
    } catch (err) {
        showError(el.joinError, el.code, err.message);
        button.disabled = false;
        button.textContent = 'Rejoindre';
    }
});

const session = getSession();
if (session) {
    el.pseudo.value = session.player.name;
    goToChoice(session.player.name);
} else {
    setStep(1);
}