import {
  DEFAULT_SCORING,
  InvalidCoordinatesError,
  WORLD_DIAGONAL_KM,
  haversineDistanceKm,
  isValidLatLng,
  mapScaleKm,
  scoreFromDistance,
  scoreGuess,
} from './scoring';

describe('haversineDistanceKm', () => {
  it('is zero for identical points', () => {
    expect(haversineDistanceKm({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0);
  });

  it('matches a known distance (Paris – London ≈ 344 km)', () => {
    const d = haversineDistanceKm({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 });
    expect(d).toBeGreaterThan(340);
    expect(d).toBeLessThan(348);
  });

  it('gives half the circumference for antipodal points', () => {
    const d = haversineDistanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(d).toBeCloseTo(Math.PI * 6371.0088, 0);
  });

  it('handles the antimeridian the short way', () => {
    const d = haversineDistanceKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    expect(d).toBeLessThan(25);
  });

  it('rejects invalid coordinates', () => {
    expect(() => haversineDistanceKm({ lat: 91, lng: 0 }, { lat: 0, lng: 0 })).toThrow(InvalidCoordinatesError);
    expect(() => haversineDistanceKm({ lat: 0, lng: 200 }, { lat: 0, lng: 0 })).toThrow(InvalidCoordinatesError);
    expect(() => haversineDistanceKm({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })).toThrow(InvalidCoordinatesError);
  });
});

describe('isValidLatLng', () => {
  it('accepts boundaries and rejects junk', () => {
    expect(isValidLatLng({ lat: -90, lng: 180 })).toBe(true);
    expect(isValidLatLng({ lat: '1', lng: 2 })).toBe(false);
    expect(isValidLatLng({ lat: Infinity, lng: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
  });
});

describe('scoreFromDistance', () => {
  it('gives the maximum for a zero-distance guess', () => {
    expect(scoreFromDistance(0)).toBe(5000);
  });

  it('gives the maximum inside the perfect radius', () => {
    expect(scoreFromDistance(0.02)).toBe(5000);
  });

  it('scores near guesses highly and far guesses low', () => {
    const near = scoreFromDistance(10);
    const mid = scoreFromDistance(1000);
    const far = scoreFromDistance(10000);
    expect(near).toBeGreaterThan(4950);
    expect(mid).toBeGreaterThan(2500);
    expect(mid).toBeLessThan(2700);
    expect(far).toBeLessThan(10);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });

  it('drops to max/e at the scale distance', () => {
    expect(scoreFromDistance(DEFAULT_SCORING.scaleKm)).toBe(Math.round(5000 / Math.E));
  });

  it('gives (almost) nothing at the maximum possible distance', () => {
    expect(scoreFromDistance(20015.1)).toBe(0);
  });

  it('returns 0 for invalid distances', () => {
    expect(scoreFromDistance(NaN)).toBe(0);
    expect(scoreFromDistance(-5)).toBe(0);
    expect(scoreFromDistance(Infinity)).toBe(0);
  });

  it('always returns an integer between 0 and 5000', () => {
    for (let d = 0; d < 21000; d += 137.3) {
      const s = scoreFromDistance(d);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(5000);
    }
  });

  it('is configurable', () => {
    expect(scoreFromDistance(10, { maxScore: 100, scaleKm: 10, perfectRadiusKm: 0 })).toBe(37);
  });
});

describe('scoreGuess', () => {
  const actual = { lat: 40, lng: -74 };

  it('scores zero with no guess', () => {
    expect(scoreGuess(null, actual)).toEqual({ distanceKm: null, score: 0 });
  });

  it('scores zero for an invalid guess', () => {
    expect(scoreGuess({ lat: 100, lng: 0 }, actual)).toEqual({ distanceKm: null, score: 0 });
  });

  it('scores a perfect guess', () => {
    expect(scoreGuess(actual, actual)).toEqual({ distanceKm: 0, score: 5000 });
  });

  it('is deterministic', () => {
    const g = { lat: 41, lng: -73 };
    expect(scoreGuess(g, actual)).toEqual(scoreGuess(g, actual));
  });
});

describe('mapScaleKm', () => {
  it('uses a floor for single-location maps', () => {
    expect(mapScaleKm([{ lat: 1, lng: 1 }])).toBe(5);
  });

  it('never exceeds the world scale', () => {
    expect(mapScaleKm([{ lat: -80, lng: -170 }, { lat: 80, lng: 170 }])).toBeLessThanOrEqual(WORLD_DIAGONAL_KM / 10);
  });
});
