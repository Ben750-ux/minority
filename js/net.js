const TOKEN_KEY = 'minority.token';
const PLAYER_KEY = 'minority.player';

export function getSession() {
    try {
        const token = localStorage.getItem(TOKEN_KEY);
        const player = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
        return token && player ? { token, player } : null;
    } catch {
        return null;
    }
}

export async function ensureSession(name) {
    const existing = getSession();
    if (existing) {
        return existing;
    }

    const data = await api('/api/session', { method: 'POST', body: { name } });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(PLAYER_KEY, JSON.stringify(data.player));
    return { token: data.token, player: data.player };
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
    const session = getSession();
    const headers = { 'Content-Type': 'application/json' };

    if (auth && session) {
        headers.Authorization = `Bearer ${session.token}`;
    }

    const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(PLAYER_KEY);
        }
        // `status` permet a l'appelant de distinguer une erreur metier
        // (409 vote clos, 403 mauvais joueur) d'une panne reseau.
        throw Object.assign(new Error(data.error || `erreur ${res.status}`), { status: res.status });
    }

    return data;
}

export function subscribe(code, onState, onError) {
    const session = getSession();
    if (!session) {
        onError(new Error('session expiree'));
        return () => { };
    }

    const url = `/api/rooms/${code}/events?token=${encodeURIComponent(session.token)}`;
    const source = new EventSource(url);

    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'state') {
                onState(payload.room);
            }
        } catch (err) {
            onError(err);
        }
    };

    source.onerror = () => onError(new Error('connexion interrompue'));

    return () => source.close();
}

export function me() {
    return getSession()?.player ?? null;
}