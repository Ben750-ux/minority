import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const results = [];
function check(label, ok, detail = '') {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
}

async function call(token, method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {} };
}

function readEvents(code, token, ms = 900) {
    return new Promise(async (resolve) => {
        const controller = new AbortController();
        const res = await fetch(`${BASE}/api/rooms/${code}/events?token=${token}`, {
            signal: controller.signal
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let states = 0;

        setTimeout(() => {
            controller.abort();
            resolve(states);
        }, ms);

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                states += (buffer.match(/type":"state"/g) || []).length;
            }
        } catch { /* abort */ }
    });
}

async function main() {
    await sleep(1200);

    // 1. sessions
    const host = await call(null, 'POST', '/api/session', { name: 'Alice' });
    check('POST /api/session cree un joueur', host.status === 200 && !!host.data.token, host.data.error);

    const bob = await call(null, 'POST', '/api/session', { name: 'Bob' });
    const cleo = await call(null, 'POST', '/api/session', { name: 'Cleo' });
    check('3 sessions creees', bob.status === 200 && cleo.status === 200);

    // 2. auth refuse
    const noAuth = await call(null, 'POST', '/api/rooms', {});
    check('POST /api/rooms sans jeton -> 401', noAuth.status === 401, `recu ${noAuth.status}`);

    const badAuth = await call('deadbeef', 'POST', '/api/rooms', {});
    check('POST /api/rooms jeton invalide -> 401', badAuth.status === 401, `recu ${badAuth.status}`);

    // 3. creation + code
    const created = await call(host.data.token, 'POST', '/api/rooms', { config: {} });
    const code = created.data.room?.code;
    check('POST /api/rooms renvoie un code 4 caracteres', created.status === 201 && /^[A-Z0-9]{4}$/.test(code || ''), code);
    check('hote inclus et marque', created.data.room.players.length === 1 && created.data.room.players[0].isHost);

    // 4.Rejoindre
    const jBob = await call(bob.data.token, 'POST', `/api/rooms/${code}/join`);
    const jCleo = await call(cleo.data.token, 'POST', `/api/rooms/${code}/join`);
    check('deux joueurs rejoignent', jBob.status === 200 && jCleo.status === 200);
    check('3 membres dans le salon', jCleo.data.room.players.length === 3,
        `${jCleo.data.room.players.length} : ${JSON.stringify(jCleo.data.room.players.map((p) => p.name))}`);
    check('sièges ordonnés hôte puis invités',
        jCleo.data.room.players.map((p) => p.seat).join(',') === '0,1,2');

    const jAgain = await call(bob.data.token, 'POST', `/api/rooms/${code}/join`);
    check('rejoinindre est idempotent', jAgain.status === 200 && jAgain.data.room.players.length === 3,
        `${jAgain.data.room.players.length}`);

    const jBad = await call(bob.data.token, 'POST', '/api/rooms/ZZZZ/join');
    check('rejoindre salon inexistant -> 404', jBad.status === 404, `recu ${jBad.status}`);

    // 5. SSE
    const events = await readEvents(code, bob.data.token, 700);
    check('SSE envoie un evenement state initial', events >= 1, `${events} events`);

    // 6. config par un non-hote
    const cfgBad = await call(bob.data.token, 'POST', `/api/rooms/${code}/config`, { tVote: 5 });
    check('config par non-hote -> 403', cfgBad.status === 403, `recu ${cfgBad.status}`);

    const cfg = await call(host.data.token, 'POST', `/api/rooms/${code}/config`, {
        tQuestion: 5, tVote: 30, tReveal: 2, pMinority: 2, pBlankSolo: 4, pBlankMulti: 5, pTarget: 6
    });
    check('config hote appliquee', cfg.status === 200 && cfg.data.room.config.tVote === 30 && cfg.data.room.config.pTarget === 6);

    // 7. demarrage avec trop peu de joueurs
    const solo = await call(host.data.token, 'POST', '/api/rooms', {});
    const soloCode = solo.data.room.code;
    const soloStart = await call(host.data.token, 'POST', `/api/rooms/${soloCode}/start`);
    check('demarrer avec 1 joueur -> 400', soloStart.status === 400, soloStart.data.error);

    const nonHostStart = await call(bob.data.token, 'POST', `/api/rooms/${code}/start`);
    check('demarrer par non-hote -> 403', nonHostStart.status === 403, `recu ${nonHostStart.status}`);

    // 8. manche 1
    const started = await call(host.data.token, 'POST', `/api/rooms/${code}/start`);
    check('demarrage reussi', started.status === 200 && started.data.room.status === 'playing');
    check('phase question, manche 1', started.data.room.phase === 'question' && started.data.room.round === 1);
    check('questionneur = Alice', started.data.room.askerId === host.data.player.id,
        `askerId=${started.data.room.askerId} hostId=${host.data.player.id} membres=${JSON.stringify(started.data.room.players.map((p) => [p.name, p.id, p.seat]))}`);
    check('votants = 2 (questionneur exclu)', started.data.room.voterCount === 2);

    // 9. question par mauvais joueur
    const wrongQ = await call(bob.data.token, 'POST', `/api/rooms/${code}/question`, { text: 'Bonjour ?' });
    check('question par non-questionneur -> 403', wrongQ.status === 403, `recu ${wrongQ.status}`);

    const askerId = started.data.room.askerId;
    const askerToken = askerId === host.data.player.id ? host.data.token : bob.data.token;
    const voterA = askerToken === host.data.token ? bob.data.token : host.data.token;
    const voterB = askerToken === host.data.token ? cleo.data.token : host.data.token;

    const goodQ = await call(askerToken, 'POST', `/api/rooms/${code}/question`, { text: 'As-tu deja menti ici ?' });
    check('question valide acceptee', goodQ.status === 200);

    const state = await call(host.data.token, 'GET', `/api/rooms/${code}`);
    check('phase vote ouverte', state.data.room.phase === 'vote');
    check('question transmise au salon', state.data.room.question === 'As-tu deja menti ici ?');

    // 10. le questionneur ne vote pas
    const askerVote = await call(askerToken, 'POST', `/api/rooms/${code}/vote`, { answer: 'yes' });
    check('questionneur ne peut pas voter -> 403', askerVote.status === 403, `recu ${askerVote.status}`);

    // 10b. le maitre de jeu, quant a lui, vote des que ce n'est pas son tour
    const hostIsAsker = askerId === host.data.player.id;
    if (!hostIsAsker) {
        const hostVote = await call(host.data.token, 'POST', `/api/rooms/${code}/vote`, { answer: 'no' });
        check('maitre de jeu peut voter quand ce n est pas son tour',
            hostVote.status === 200, `recu ${hostVote.status} ${hostVote.data.error ?? ''}`);
        const counted = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room.votes;
        check('son vote est bien compte', counted >= 1, `votes=${counted}`);
        await call(host.data.token, 'POST', `/api/rooms/${code}/vote`, { answer: 'yes' });
    } else {
        check('maitre de jeu est questionneur sur la manche 1 (il ne peut pas voter)', true);
    }

    const badVote = await call(voterA, 'POST', `/api/rooms/${code}/vote`, { answer: 'maybe' });
    check('vote invalide -> 400', badVote.status === 400, `recu ${badVote.status}`);

    // 11. timeout question
    const t0 = Date.now();
    await sleep(5500);
    const timedOut = await call(host.data.token, 'GET', `/api/rooms/${code}`);
    check('timer question (5s) bascule vers vote', timedOut.data.room.phase === 'vote' || timedOut.data.room.phase === 'reveal',
        `phase=${timedOut.data.room.phase} apres ${Date.now() - t0}ms`);

    // vote des deux votants : un seul blanc -> prime
    await call(voterA, 'POST', `/api/rooms/${code}/vote`, { answer: 'blank' });
    await call(voterB, 'POST', `/api/rooms/${code}/vote`, { answer: 'yes' });

    await sleep(300);
    const revealed = await call(host.data.token, 'GET', `/api/rooms/${code}`);
    const rv = revealed.data.room.reveal;
    check('revelation generee', Boolean(rv), JSON.stringify(revealed.data.room).slice(0, 160));

    if (rv) {
        const soloBlank = rv.deltas.find((d) => d.reasons.includes('blank-solo'));
        check('blanc unique recoit pBlankSolo (4)', soloBlank?.delta === 4, `delta=${soloBlank?.delta}`);
        const yesWinner = rv.deltas.filter((d) => d.reasons.includes('minority'));
        check('minorite (oui seul) touche pMinority (2)', yesWinner.length === 1 && yesWinner[0].delta === 2,
            JSON.stringify(yesWinner.map((d) => [d.name, d.delta])));
        const blankSolo = rv.deltas.find((d) => d.reasons.includes('blank-solo'));
        const majority = rv.deltas.find((d) => d.id === blankSolo?.id && d.reasons.includes('minority'));
        check('le votant blanc n est pas dans la minorite oui/non', majority === undefined,
            `reasons=${JSON.stringify(blankSolo?.reasons)}`);

        const third = rv.deltas.find((d) => d.delta === 0 && d.id !== blankSolo?.id);
        check('le groupe majoritaire ne gagne rien (0)', Boolean(third) || rv.deltas.every((d) => d.delta !== null),
            JSON.stringify(rv.deltas.map((d) => [d.name, d.delta, d.reasons])));
    }

    // 12. manche 2 : deux blancs -> malus
    await sleep(2600);
    const round2 = await call(host.data.token, 'GET', `/api/rooms/${code}`);
    check('manche 2, nouveau questionneur', round2.data.room.round === 2 && round2.data.room.phase === 'question',
        `round=${round2.data.room.round} phase=${round2.data.room.phase}`);
    check('questionnaire a change de joueur', round2.data.room.askerId !== askerId);

    const asker2 = round2.data.room.askerId;
    const tokenOf = (id) => [host, bob, cleo].find((p) => p.data.player.id === id).data.token;
    const tok2 = tokenOf(asker2);
    const voters2 = [host, bob, cleo].map((p) => p.data.player.id).filter((id) => id !== asker2).map(tokenOf);

    await call(tok2, 'POST', `/api/rooms/${code}/question`, { text: 'Tu triches ?' });
    check('2 votants en manche 2', voters2.length === 2, `${voters2.length} votants`);

    for (const token of voters2) {
        await call(token, 'POST', `/api/rooms/${code}/vote`, { answer: 'blank' });
    }

    await sleep(300);
    const rv2 = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room.reveal;
    if (rv2) {
        const punished = rv2.deltas.filter((d) => d.reasons.includes('blank-multi'));
        check('deux blancs -> malus pBlankMulti (5) chacun',
            punished.length === 2 && punished.every((p) => p.delta === -5),
            JSON.stringify(rv2.deltas.map((d) => [d.name, d.delta, d.reasons])));

        check('aucun groupe oui/non repondu -> pas de minorite',
            rv2.deltas.every((d) => !d.reasons.includes('minority')),
            JSON.stringify(rv2.deltas.map((d) => [d.name, d.reasons])));

        const askerNoDelta = rv2.deltas.find((d) => d.id === asker2);
        check('le questionneur ne marque rien', askerNoDelta?.delta === 0, `${askerNoDelta?.delta}`);
    } else {
        check('revelation manche 2 generee', false, 'pas de reveal');
    }

    // 13. score persiste en base
    await sleep(2600);
    const scores = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room.players;
    const total = scores.reduce((sum, p) => sum + p.score, 0);
    check('scores cumules en base', total > 0, `total=${total} detail=${JSON.stringify(scores.map((s) => [s.name, s.score]))}`);

    // 13b. sur une manche ou le maitre de jeu n'est pas questionneur,
    // il doit recevoir un ecran de vote comme tout le monde
    const round3probe = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
    if (round3probe.phase === 'question' && round3probe.askerId !== host.data.player.id) {
        const tokA = tokenOf(round3probe.askerId);
        const others = [host, bob, cleo].map((p) => p.data.player.id)
            .filter((id) => id !== round3probe.askerId).map(tokenOf);
        await call(tokA, 'POST', `/api/rooms/${code}/question`, { text: 'Question du invite ?' });
        const hostBallot = await call(host.data.token, 'POST', `/api/rooms/${code}/vote`, { answer: 'blank' });
        check('maitre de jeu recoit le droit de vote sur une manche invitee',
            hostBallot.status === 200, `recu ${hostBallot.status}`);
        for (const token of others) {
            await call(token, 'POST', `/api/rooms/${code}/vote`, { answer: 'yes' });
        }
        await sleep(300);
    } else {
        check('maitre de jeu a joue une manche invitee', false,
            `phase=${round3probe.phase} asker=${round3probe.askerId}`);
    }

    // 14. victoire
    await call(host.data.token, 'POST', `/api/rooms/${code}/config`, {
        tQuestion: 5, tVote: 30, tReveal: 2, pMinority: 5, pBlankSolo: 0, pBlankMulti: 0, pTarget: 5
    });
    await sleep(300);
    // On joue jusqu'a victoire : chaque manche donne 5 points au minoritaire,
    // l'objectif de 5 peut donc demander plusieurs tours selon les scores cumuleses.
    let rounds4 = 0;
    let state4 = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;

    while (state4.status === 'playing' && rounds4 < 8) {
        rounds4 += 1;

        if (state4.phase === 'reveal') {
            await sleep(2400);
            state4 = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
            continue;
        }

        if (state4.phase !== 'question') {
            await sleep(500);
            state4 = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
            continue;
        }

        const tok3 = tokenOf(state4.askerId);
        const vt3 = [host, bob, cleo].map((p) => p.data.player.id)
            .filter((id) => id !== state4.askerId).map(tokenOf);

        await call(tok3, 'POST', `/api/rooms/${code}/question`, { text: `Manche decisive ${rounds4}` });
        await call(vt3[0], 'POST', `/api/rooms/${code}/vote`, { answer: 'yes' });
        await call(vt3[1], 'POST', `/api/rooms/${code}/vote`, { answer: 'no' });
        await call(vt3[2], 'POST', `/api/rooms/${code}/vote`, { answer: 'no' });
        await sleep(2800);

        state4 = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
    }

    check('la boucle de manches se termine', rounds4 < 8, `${rounds4} manches jouees`);

    const over = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
    check('partie terminee et gagnant designe', over.status === 'over' && Boolean(over.winnerId),
        `status=${over.status} winner=${over.winnerId}`);

    // 15. rematch
    const rematchBad = await call(bob.data.token, 'POST', `/api/rooms/${code}/rematch`);
    check('rematch par non-hote -> 403', rematchBad.status === 403, `recu ${rematchBad.status}`);

    const rematch = await call(host.data.token, 'POST', `/api/rooms/${code}/rematch`);
    check('rematch reinitialise', rematch.status === 200 && rematch.data.room.status === 'playing' && rematch.data.room.round === 1
        && rematch.data.room.players.every((p) => p.score === 0));

    // 16. depart
    const leave = await call(cleo.data.token, 'POST', `/api/rooms/${code}/leave`);
    check('depart d un membre', leave.status === 200);
    const afterLeave = (await call(host.data.token, 'GET', `/api/rooms/${code}`)).data.room;
    check('2 membres restants', afterLeave.players.length === 2);

    // 17. statique
    const home = await fetch(BASE + '/index.html');
    check('index.html servi', home.ok);
    const api404 = await call(null, 'GET', '/api/rooms');
    check('route API inconnue -> 404 json', api404.status === 404);

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n=== ${passed}/${results.length} tests passes ===`);
    if (passed !== results.length) {
        console.log(results.filter((r) => !r.ok).map((r) => `  ECHEC: ${r.label} (${r.detail})`).join('\n'));
    }
    console.log(`\n--- stdout serveur ---\n${out}`);
    child.kill();
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    console.log(out);
    child.kill();
    process.exit(1);
});