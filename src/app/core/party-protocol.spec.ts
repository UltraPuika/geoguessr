import {
  PartyGame,
  createPartyCode,
  decodePayload,
  normalizePartyCode,
  normalizePlayerName,
  parseClientMessage,
  parseHostMessage,
  rankBoard,
} from './party-protocol';

const state = (over: Record<string, unknown> = {}) => ({
  t: 'state',
  state: {
    playerId: 'player-1234',
    name: 'Ann',
    roundsPlayed: 2,
    totalScore: 9000,
    finished: false,
    ...over,
  },
});

const game: PartyGame = {
  setup: {
    mapId: 'm1',
    mapName: 'Alps',
    rounds: 1,
    timeLimitSec: 30,
    mode: 'nmpz',
    order: 'random',
    allowRepeats: false,
    scoringScale: 'world',
  },
  locations: [
    {
      id: 'l1',
      mapId: 'm1',
      order: 0,
      lat: 46.5,
      lng: 8.5,
      name: 'Furka',
      notes: 'secret notes',
      panoId: null,
      heading: 120,
      pitch: 0,
      zoom: 1,
      coverage: 'ok',
      coverageCheckedAt: null,
    },
  ],
  scaleKm: 1491.7,
  pace: 'self',
};

describe('party codes', () => {
  it('creates codes that normalise back to themselves', () => {
    for (let i = 0; i < 20; i++) {
      const code = createPartyCode();
      expect(normalizePartyCode(code.toLowerCase())).toBe(code);
    }
  });

  it('rejects wrong length and ambiguous characters', () => {
    expect(normalizePartyCode('ABC')).toBeNull();
    expect(normalizePartyCode('ABCDE0')).toBeNull();
    expect(normalizePartyCode('ABCD/../')).toBeNull();
  });
});

describe('normalizePlayerName', () => {
  it('trims, collapses whitespace, strips control/bidi characters and caps length', () => {
    expect(normalizePlayerName('  Ann \n  Lee\u202e ')).toBe('Ann Lee');
    expect(normalizePlayerName('x'.repeat(100))).toHaveLength(24);
    expect(normalizePlayerName(42)).toBe('');
  });
});

describe('parseClientMessage', () => {
  it('accepts a valid snapshot', () => {
    const msg = parseClientMessage(state(), 5);
    expect(msg?.t === 'state' && msg.state.totalScore).toBe(9000);
  });

  it.each([
    ['too many rounds', { roundsPlayed: 6 }],
    ['score above 5,000 per played round', { totalScore: 10_001 }],
    ['negative score', { totalScore: -1 }],
    ['fractional score', { totalScore: 1.5 }],
    ['finished early', { finished: true }],
    ['empty name', { name: '   ' }],
    ['malformed player id', { playerId: 'x' }],
  ])('rejects %s', (_label, over) => {
    expect(parseClientMessage(state(over), 5)).toBeNull();
  });

  it('rejects other message types', () => {
    expect(parseClientMessage({ t: 'game', game }, 5)).toBeNull();
    expect(parseClientMessage(null, 5)).toBeNull();
  });

  it('accepts live joins and guesses', () => {
    expect(parseClientMessage({ t: 'join', playerId: 'player-1234', name: ' Ann ' }, 5)).toEqual({
      t: 'join',
      playerId: 'player-1234',
      name: 'Ann',
    });
    const guess = { t: 'guess', playerId: 'player-1234', round: 4, guess: { lat: 1, lng: 2, x: 1 } };
    expect(parseClientMessage(guess, 5)).toEqual({ ...guess, guess: { lat: 1, lng: 2 } });
    expect(parseClientMessage({ ...guess, guess: null }, 5)).toMatchObject({ guess: null });
  });

  it.each([
    ['round past the end', { round: 5 }],
    ['invalid coordinates', { guess: { lat: 95, lng: 0 } }],
    ['missing guess', { guess: undefined }],
    ['malformed player id', { playerId: '../x' }],
  ])('rejects a live guess with %s', (_label, over) => {
    const guess = { t: 'guess', playerId: 'player-1234', round: 0, guess: { lat: 1, lng: 2 }, ...over };
    expect(parseClientMessage(guess, 5)).toBeNull();
  });
});

describe('parseHostMessage', () => {
  it('accepts a game and drops fields phones do not need', () => {
    const msg = parseHostMessage(JSON.parse(JSON.stringify({ t: 'game', game })));
    expect(msg?.t).toBe('game');
    if (msg?.t !== 'game') return;
    expect(msg.game.locations[0]).toMatchObject({ lat: 46.5, lng: 8.5, heading: 120, notes: '' });
    expect(msg.game.setup.rounds).toBe(1);
  });

  it('keeps the live pace and treats a missing pace as self-paced', () => {
    const live = parseHostMessage({ t: 'game', game: { ...game, pace: 'live' } });
    expect(live?.t === 'game' && live.game.pace).toBe('live');
    const { pace: _omitted, ...old } = game;
    const legacy = parseHostMessage({ t: 'game', game: old });
    expect(legacy?.t === 'game' && legacy.game.pace).toBe('self');
  });

  it('validates live phases', () => {
    const entry = { playerId: 'player-1234', name: 'Ann', guess: { lat: 1, lng: 2 }, distanceKm: 12.5, score: 4000 };
    const reveal = { t: 'phase', phase: { kind: 'reveal', round: 0, results: [entry] } };
    expect(parseHostMessage(reveal)).toEqual(reveal);
    expect(parseHostMessage({ t: 'phase', phase: { kind: 'round', round: 2, durationMs: null } })).toEqual({
      t: 'phase',
      phase: { kind: 'round', round: 2, durationMs: null },
    });
    const bad = (phase: unknown) => parseHostMessage({ t: 'phase', phase });
    expect(bad({ kind: 'round', round: -1, durationMs: 30_000 })).toBeNull();
    // A re-published round with no time left is still valid.
    expect(bad({ kind: 'round', round: 0, durationMs: 0 })).not.toBeNull();
    expect(bad({ kind: 'round', round: 0, durationMs: 'soon' })).toBeNull();
    expect(bad({ kind: 'reveal', round: 0, results: [{ ...entry, score: 5001 }] })).toBeNull();
    expect(bad({ kind: 'reveal', round: 0, results: [{ ...entry, guess: null }] })).toBeNull();
    expect(bad({ kind: 'party' })).toBeNull();
  });

  it('rejects invalid coordinates, modes and empty games', () => {
    const bad = (patch: (g: PartyGame) => void) => {
      const g = structuredClone(game);
      patch(g);
      return parseHostMessage({ t: 'game', game: g });
    };
    expect(bad((g) => (g.locations[0].lat = 91))).toBeNull();
    expect(bad((g) => ((g.setup as { mode: string }).mode = 'cheat'))).toBeNull();
    expect(bad((g) => (g.locations = []))).toBeNull();
    expect(bad((g) => (g.scaleKm = Number.NaN))).toBeNull();
  });

  it('validates leaderboard entries', () => {
    const entry = {
      playerId: 'player-1234',
      name: 'Ann',
      roundsPlayed: 1,
      totalScore: 10,
      finished: false,
      connected: true,
    };
    expect(parseHostMessage({ t: 'board', entries: [entry] })).toEqual({
      t: 'board',
      entries: [entry],
    });
    expect(parseHostMessage({ t: 'board', entries: [{ ...entry, totalScore: '10' }] })).toBeNull();
    expect(parseHostMessage({ t: 'board', entries: [{ ...entry, playerId: '../x' }] })).toBeNull();
  });
});

describe('decodePayload', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('parses JSON and ignores empty, oversized or malformed payloads', () => {
    expect(decodePayload(bytes('{"t":"closed"}'), 100)).toEqual({ t: 'closed' });
    expect(decodePayload(new Uint8Array(), 100)).toBeNull();
    expect(decodePayload(bytes('{"t":"closed"}'), 5)).toBeNull();
    expect(decodePayload(bytes('{oops'), 100)).toBeNull();
  });
});

describe('rankBoard', () => {
  it('sorts by score, then fewer rounds played', () => {
    const e = (name: string, totalScore: number, roundsPlayed: number) => ({
      name,
      totalScore,
      roundsPlayed,
      finished: false,
    });
    expect(rankBoard([e('a', 100, 2), e('b', 300, 3), e('c', 100, 1)]).map((x) => x.name)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});
