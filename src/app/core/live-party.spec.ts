import { everyoneAnswered, scoreLiveRound } from './live-party';
import { DEFAULT_SCORING } from './scoring';

const players = [
  { playerId: 'p-aaaaaaaa', name: 'Ann', connected: true },
  { playerId: 'p-bbbbbbbb', name: 'Bob', connected: true },
  { playerId: 'p-cccccccc', name: 'Cy', connected: false },
];

describe('scoreLiveRound', () => {
  it('scores every player, gives 0 to anyone who did not answer, and ranks best first', () => {
    const guesses = new Map([
      ['p-aaaaaaaa', { lat: 10, lng: 10 }],
      ['p-bbbbbbbb', { lat: 0, lng: 0 }],
    ]);
    const results = scoreLiveRound(players, guesses, { lat: 0, lng: 0 }, DEFAULT_SCORING);
    expect(results.map((r) => r.name)).toEqual(['Bob', 'Ann', 'Cy']);
    expect(results[0]).toMatchObject({ score: 5000, distanceKm: 0 });
    expect(results[1].score).toBeGreaterThan(0);
    expect(results[1].score).toBeLessThan(5000);
    expect(results[2]).toMatchObject({ guess: null, distanceKm: null, score: 0 });
  });

  it('treats a null answer (time ran out) like no answer', () => {
    const results = scoreLiveRound(
      players.slice(0, 1),
      new Map([['p-aaaaaaaa', null]]),
      { lat: 0, lng: 0 },
      DEFAULT_SCORING,
    );
    expect(results[0]).toMatchObject({ guess: null, score: 0 });
  });
});

describe('everyoneAnswered', () => {
  it('waits only for connected players', () => {
    expect(everyoneAnswered(players, new Map([['p-aaaaaaaa', null]]))).toBe(false);
    expect(
      everyoneAnswered(
        players,
        new Map([
          ['p-aaaaaaaa', null],
          ['p-bbbbbbbb', null],
        ]),
      ),
    ).toBe(true);
  });

  it('never closes a round with nobody connected', () => {
    expect(everyoneAnswered([{ playerId: 'p-cccccccc', connected: false }], new Map())).toBe(false);
  });
});
