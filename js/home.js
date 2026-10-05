const FEATURES = [
    {
        title: 'Timers réglables',
        text: 'Durée de la question, du vote et de la révélation : tout se choisit à la création du salon.'
    },
    {
        title: 'Scores réglables',
        text: 'Gain de la minorité, prime du vote blanc unique et malus du blanc multiple : vous décidez.'
    },
    {
        title: 'Objectif au choix',
        text: '12, 20 ou 50 points. Le premier joueur à l\'atteindre·là gagne la partie.'
    }
];

const grid = document.createElement('div');
grid.className = 'modes__grid';

FEATURES.forEach((feature) => {
    const card = document.createElement('article');
    card.className = 'mode';

    const title = document.createElement('h3');
    title.textContent = feature.title;

    const text = document.createElement('p');
    text.textContent = feature.text;

    card.append(title, text);
    grid.append(card);
});

document.querySelector('.modes').append(grid);