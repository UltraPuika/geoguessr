import { GameSession, describeRoundPlan, planRounds, shuffle, summarizeRounds } from './game-engine';
import { GameSetup, MapLocation } from './models';

function loc(i: number, lat = i, lng = i): MapLocation {
  return {
    id: `L${i}`,
    mapId: 'm',
    order: i,
    lat,
    lng,
    name: `Loc ${i}`,
    notes: '',
    panoId: null,
    heading: 0,
    pitch: 0,
    zoom: 1,
    coverage: 'ok',
    coverageCheckedAt: null,
  };
}

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const setup: GameSetup = {
  mapId: 'm',
  mapName: 'Test',
  rounds: 3,
  timeLimitSec: null,
  mode: 'moving',
  order: 'fixed',
  allowRepeats: false,
  scoringScale: 'world',
};

describe('planRounds', () => {
  const locs = [loc(2), loc(0), loc(1), loc(3), loc(4)];

  it('uses fixed order by the location order field', () => {
    const plan = planRounds(locs, 3, 'fixed', false);
    expect(plan.locations.map((l) => l.id)).toEqual(['L0', 'L1', 'L2']);
    expect(plan.effectiveRounds).toBe(3);
    expect(plan.message).toBeNull();
  });

  it('randomizes without duplicates when enough locations exist', () => {
    const plan = planRounds(locs, 5, 'random', false, seeded(42));
    const ids = plan.locations.map((l) => l.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('caps the round count when there are too few locations and repeats are off', () => {
    const plan = planRounds(locs.slice(0, 2), 5, 'random', false, seeded(1));
    expect(plan.effectiveRounds).toBe(2);
    expect(plan.capped).toBe(true);
    expect(plan.message).toContain('only 2 locations');
    expect(new Set(plan.locations.map((l) => l.id)).size).toBe(2);
  });

  it('repeats locations when allowed, without back-to-back repeats', () => {
    const plan = planRounds(locs.slice(0, 2), 7, 'random', true, seeded(7));
    expect(plan.effectiveRounds).toBe(7);
    expect(plan.repeats).toBe(true);
    for (let i = 1; i < plan.locations.length; i++) {
      expect(plan.locations[i].id).not.toBe(plan.locations[i - 1].id);
    }
  });

  it('cycles in fixed order when repeating', () => {
    const plan = planRounds([loc(0), loc(1)], 5, 'fixed', true);
    expect(plan.locations.map((l) => l.id)).toEqual(['L0', 'L1', 'L0', 'L1', 'L0']);
  });

  it('reports an empty map', () => {
    const info = describeRoundPlan(0, 5, true);
    expect(info.effectiveRounds).toBe(0);
    expect(info.message).toMatch(/no locations/);
  });

  it('shuffle keeps all items', () => {
    const out = shuffle([1, 2, 3, 4, 5, 6], seeded(3));
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('GameSession', () => {
  let now: number;
  const make = (n = 3) => new GameSession(setup, [loc(0, 10, 10), loc(1, 20, 20), loc(2, 30, 30)].slice(0, n), undefined, () => now);

  beforeEach(() => {
    now = 0;
  });

  it('progresses through rounds in order', () => {
    const g = make();
    expect(g.index).toBe(0);
    expect(g.phase).toBe('loading');
    expect(g.markRoundReady()).toBe(true);
    expect(g.placeGuess({ lat: 10, lng: 10 })).toBe(true);
    expect(g.submit('manual')?.score).toBe(5000);
    expect(g.next()).toBe(true);
    expect(g.index).toBe(1);
    expect(g.phase).toBe('loading');
    expect(g.guess).toBeNull();
  });

  it('requires a guess for manual submission', () => {
    const g = make();
    g.markRoundReady();
    expect(g.submit('manual')).toBeNull();
    expect(g.phase).toBe('guessing');
  });

  it('does not accept guesses or submissions twice', () => {
    const g = make();
    g.markRoundReady();
    g.placeGuess({ lat: 11, lng: 11 });
    const first = g.submit('manual');
    expect(first).not.toBeNull();
    // Timer firing right after the click must not create a second result.
    expect(g.submit('timeout')).toBeNull();
    expect(g.submit('manual')).toBeNull();
    expect(g.placeGuess({ lat: 10, lng: 10 })).toBe(false);
    expect(g.clearGuess()).toBe(false);
    expect(g.roundResults.length).toBe(1);
  });

  it('scores a timeout without a guess as zero', () => {
    const g = make();
    g.markRoundReady();
    now = 5000;
    const r = g.submit('timeout')!;
    expect(r.score).toBe(0);
    expect(r.guess).toBeNull();
    expect(r.distanceKm).toBeNull();
    expect(r.timeTakenMs).toBe(5000);
  });

  it('scores a timeout with a placed guess', () => {
    const g = make();
    g.markRoundReady();
    g.placeGuess({ lat: 10, lng: 10 });
    expect(g.submit('timeout')!.score).toBe(5000);
  });

  it('allows skipping a round that failed to load, for zero points', () => {
    const g = make();
    expect(g.submit('timeout')).toBeNull();
    const r = g.submit('skipped')!;
    expect(r.score).toBe(0);
    expect(r.reason).toBe('skipped');
  });

  it('cannot advance before submitting', () => {
    const g = make();
    g.markRoundReady();
    expect(g.next()).toBe(false);
  });

  it('finishes after the last round and aggregates scores', () => {
    const g = make(2);
    g.markRoundReady();
    g.placeGuess({ lat: 10, lng: 10 });
    g.submit('manual');
    g.next();
    g.markRoundReady();
    g.placeGuess({ lat: 21, lng: 20 });
    g.submit('manual');
    expect(g.next()).toBe(true);
    expect(g.isFinished).toBe(true);
    expect(g.next()).toBe(false);
    const s = summarizeRounds(g.roundResults, 5000);
    expect(s.maxScore).toBe(10000);
    expect(s.totalScore).toBe(g.roundResults[0].score + g.roundResults[1].score);
    expect(s.guessedRounds).toBe(2);
    expect(s.averageDistanceKm).toBeCloseTo(s.totalDistanceKm / 2, 6);
  });
});

describe('summarizeRounds', () => {
  it('excludes rounds without a guess from distance averages', () => {
    const s = summarizeRounds(
      [
        { index: 0, locationId: 'a', locationName: '', actual: { lat: 0, lng: 0 }, guess: { lat: 0, lng: 1 }, distanceKm: 100, score: 4000, reason: 'manual', timeTakenMs: 1 },
        { index: 1, locationId: 'b', locationName: '', actual: { lat: 0, lng: 0 }, guess: null, distanceKm: null, score: 0, reason: 'timeout', timeTakenMs: 1 },
      ],
      5000,
    );
    expect(s).toEqual({ totalScore: 4000, maxScore: 10000, totalDistanceKm: 100, averageDistanceKm: 100, guessedRounds: 1 });
  });

  it('gives 25,000 max for five rounds', () => {
    const rounds = Array.from({ length: 5 }, (_, i) => ({
      index: i,
      locationId: `${i}`,
      locationName: '',
      actual: { lat: 0, lng: 0 },
      guess: { lat: 0, lng: 0 },
      distanceKm: 0,
      score: 5000,
      reason: 'manual' as const,
      timeTakenMs: 1,
    }));
    expect(summarizeRounds(rounds, 5000)).toMatchObject({ totalScore: 25000, maxScore: 25000 });
  });
});
