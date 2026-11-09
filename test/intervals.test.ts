import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeIntervals, type Interval } from '../src/intervals';

// Read the spec in src/intervals/mergeIntervals.ts, then check your progress
// with `npm run mutants:intervals`.
//
// Label every property with its pattern, on the line above its `it(`:
//   // Pattern: invariant. The output is sorted.
// (invariant, algebraic, metamorphic, differential, or conditional)

// Generators --------------------------------------------------------------
// The first draft drew start and end independently, so start > end happened
// half the time and the function (correctly) threw RangeError. Fix: build
// valid inputs by construction: a start plus a non-negative length.
//
// The range is deliberately tiny so intervals often overlap, nest, duplicate,
// and (crucially) touch at exactly one endpoint or sit exactly 1 apart.
const interval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -15, max: 15 }), fc.nat(8))
  .map(([start, len]): Interval => [start, start + len]);
const intervalList = fc.array(interval, { maxLength: 12 });

// Wider, sparser intervals too, so we also exercise big gaps and big spans.
const wideInterval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -1000, max: 1000 }), fc.nat(500))
  .map(([start, len]): Interval => [start, start + len]);
const anyIntervalList = fc.oneof(intervalList, fc.array(wideInterval, { maxLength: 12 }));

// A list together with a random permutation of it.
const listAndShuffle = anyIntervalList.chain(xs =>
  fc
    .shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })
    .map(shuffled => [xs, shuffled] as const),
);

// A list of intervals that are already pairwise disjoint and do NOT touch,
// built directly: each next start is at least (previous end + 1). A gap of
// exactly 1 (the tightest legal gap for integers) is generated often.
const separatedList: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -50, max: 50 }),
    fc.array(fc.tuple(fc.nat(3), fc.nat(6)), { maxLength: 10 }),
  )
  .map(([origin, steps]) => {
    const out: Interval[] = [];
    let cursor = origin;
    for (const [extraGap, len] of steps) {
      const start = cursor;
      const end = start + len;
      out.push([start, end]);
      cursor = end + 1 + extraGap; // end < next start: strictly separated
    }
    return out;
  });

// Reference "is point p covered?" for a list of closed intervals.
const covers = (xs: readonly Interval[], p: number) => xs.some(([s, e]) => s <= p && p <= e);

// Points to probe: every integer AND half-integer around the data, since the
// spec says coverage is over all reals (so gaps like (2,3) must stay gaps).
const probePoints = (xs: readonly Interval[]): number[] => {
  const all = xs.flat();
  if (all.length === 0) return [0, 0.5, -0.5];
  const lo = Math.min(...all) - 1;
  const hi = Math.max(...all) + 1;
  // Wide inputs: don't enumerate every point, probe around each endpoint.
  if (hi - lo > 200) {
    return all.flatMap(v => [v - 1, v - 0.5, v - 0.25, v, v + 0.25, v + 0.5, v + 1]);
  }
  const pts: number[] = [];
  for (let p = lo; p <= hi; p += 0.5) pts.push(p);
  return pts;
};

describe('mergeIntervals', () => {
  // Pattern: invariant. Every input interval lies inside some output interval.
  it('every input interval lies inside some output interval', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const out = mergeIntervals(xs);
        const uncovered = xs.filter(([s, e]) => !out.some(([a, b]) => a <= s && e <= b));
        expect(uncovered).toEqual([]);
      }),
    );
  });

  // Pattern: invariant. Output is well-formed: integer endpoints, start <= end,
  // sorted by start, and consecutive intervals neither overlap nor touch.
  it('output is sorted, well-formed, and strictly separated', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const out = mergeIntervals(xs);
        for (const [s, e] of out) {
          expect(Number.isInteger(s) && Number.isInteger(e)).toBe(true);
          expect(s).toBeLessThanOrEqual(e);
        }
        for (let i = 0; i + 1 < out.length; i++) {
          expect(out[i]![1]).toBeLessThan(out[i + 1]![0]);
        }
      }),
    );
  });

  // Pattern: invariant. Empty in, empty out; non-empty in, non-empty out.
  it('output is empty exactly when input is empty', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        expect(mergeIntervals(xs).length === 0).toBe(xs.length === 0);
      }),
    );
  });

  // Pattern: invariant. Output never has more intervals than the input, and
  // its endpoints all come from the input (merging invents no new numbers).
  it('output is no bigger than input and only uses input endpoints', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const out = mergeIntervals(xs);
        expect(out.length).toBeLessThanOrEqual(xs.length);
        const starts = new Set(xs.map(i => i[0]));
        const ends = new Set(xs.map(i => i[1]));
        for (const [s, e] of out) {
          expect(starts.has(s)).toBe(true);
          expect(ends.has(e)).toBe(true);
        }
      }),
    );
  });

  // Pattern: invariant. The input array and its intervals are not modified.
  it('does not mutate its input', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const snapshot = xs.map(([s, e]) => [s, e]);
        const frozen = xs.map(i => Object.freeze([...i]) as unknown as Interval);
        Object.freeze(frozen);
        mergeIntervals(frozen);
        expect(frozen.map(([s, e]) => [s, e])).toEqual(snapshot);
        // Also with a plain, mutable input.
        const mutable = xs.map(([s, e]): Interval => [s, e]);
        const out = mergeIntervals(mutable);
        expect(mutable).toEqual(snapshot);
        // And the output must not alias the input's interval objects.
        for (const o of out) for (const i of mutable) expect(o).not.toBe(i);
      }),
    );
  });

  // Pattern: differential. A point is covered by the output iff it is covered
  // by the input (checked at integers AND half-integers, so gaps are real).
  it('covers exactly the same points as the input', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const out = mergeIntervals(xs);
        for (const p of probePoints(xs)) {
          expect(covers(out, p)).toBe(covers(xs, p));
        }
      }),
    );
  });

  // Pattern: metamorphic. Reordering the input does not change the output.
  it('is insensitive to input order', () => {
    fc.assert(
      fc.property(listAndShuffle, ([xs, shuffled]) => {
        expect(mergeIntervals(shuffled)).toEqual(mergeIntervals(xs));
      }),
    );
  });

  // Pattern: metamorphic. Duplicating intervals does not change the output.
  it('is insensitive to duplicates', () => {
    fc.assert(
      fc.property(anyIntervalList, anyIntervalList, (xs, extra) => {
        const dups = extra.length ? [...xs, ...xs, ...xs.slice(0, 2)] : [...xs, ...xs];
        expect(mergeIntervals(dups)).toEqual(mergeIntervals(xs));
      }),
    );
  });

  // Pattern: metamorphic. Adding an interval that lies inside one already in
  // the input does not change the output.
  it('ignores an interval nested inside an existing one', () => {
    fc.assert(
      fc.property(
        fc.array(interval, { minLength: 1, maxLength: 10 }).chain(xs =>
          fc.nat(xs.length - 1).chain(idx => {
            const [s, e] = xs[idx]!;
            return fc
              .tuple(fc.integer({ min: s, max: e }), fc.integer({ min: s, max: e }))
              .map(([a, b]): [Interval[], Interval] => [xs, [Math.min(a, b), Math.max(a, b)]]);
          }),
        ),
        ([xs, nested]) => {
          expect(mergeIntervals([...xs, nested])).toEqual(mergeIntervals(xs));
        },
      ),
    );
  });

  // Pattern: metamorphic. Shifting every interval by k shifts the output by k.
  it('commutes with translation', () => {
    fc.assert(
      fc.property(anyIntervalList, fc.integer({ min: -100, max: 100 }), (xs, k) => {
        const shifted = xs.map(([s, e]): Interval => [s + k, e + k]);
        const expected = mergeIntervals(xs).map(([s, e]): Interval => [s + k, e + k]);
        expect(mergeIntervals(shifted)).toEqual(expected);
      }),
    );
  });

  // Pattern: algebraic. Merging is idempotent: merging merged output is a no-op.
  it('is idempotent', () => {
    fc.assert(
      fc.property(anyIntervalList, xs => {
        const once = mergeIntervals(xs);
        expect(mergeIntervals(once)).toEqual(once);
      }),
    );
  });

  // Pattern: algebraic. Merge distributes over concatenation: merging two
  // lists together equals merging their separately-merged results.
  it('merge(a ++ b) equals merge(merge(a) ++ merge(b))', () => {
    fc.assert(
      fc.property(anyIntervalList, anyIntervalList, (a, b) => {
        expect(mergeIntervals([...a, ...b])).toEqual(
          mergeIntervals([...mergeIntervals(a), ...mergeIntervals(b)]),
        );
      }),
    );
  });

  // Pattern: conditional. If the input intervals are already disjoint and not
  // touching, the output is the input sorted by start (in any input order).
  it('leaves separated intervals unchanged', () => {
    fc.assert(
      fc.property(
        separatedList.chain(xs =>
          fc
            .shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })
            .map(shuffled => [xs, shuffled] as const),
        ),
        ([sortedXs, shuffled]) => {
          expect(mergeIntervals(shuffled)).toEqual(sortedXs);
        },
      ),
    );
  });

  // Pattern: conditional. If two intervals touch or overlap, they merge into
  // one; if there is a gap, they stay two. (Both sides built directly.)
  it('touching or overlapping pairs merge; gapped pairs do not', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -20, max: 20 }),
        fc.nat(6),
        fc.integer({ min: -6, max: 6 }), // offset of 2nd start relative to 1st end
        fc.nat(6),
        (s1, len1, offset, len2) => {
          const e1 = s1 + len1;
          const s2 = e1 + offset;
          const e2 = s2 + len2;
          const out = mergeIntervals([[s1, e1], [s2, e2]]);
          if (offset <= 0 && s2 >= s1) {
            // s2 within [s1, e1] (overlap, or touch when offset === 0)
            expect(out).toEqual([[s1, Math.max(e1, e2)]]);
          } else if (offset >= 1) {
            expect(out).toEqual([[s1, e1], [s2, e2]]);
          }
        },
      ),
    );
  });

  // Pattern: conditional. Preconditions: invalid intervals throw RangeError.
  it('throws RangeError on start > end or non-integer endpoints', () => {
    fc.assert(
      fc.property(
        anyIntervalList,
        fc.oneof(
          fc.tuple(fc.integer({ min: -20, max: 20 }), fc.integer({ min: 1, max: 10 })).map(
            ([s, d]): Interval => [s, s - d],
          ),
          fc.tuple(fc.double({ noInteger: true, min: -20, max: 20, noNaN: true }), fc.nat(5)).map(
            ([s, d]): Interval => [s, s + d],
          ),
          fc.tuple(fc.integer({ min: -20, max: 20 }), fc.double({ noInteger: true, min: 21, max: 40, noNaN: true })).map(
            ([s, e]): Interval => [s, e],
          ),
          fc.constantFrom<Interval>([NaN, 1], [0, NaN], [0, Infinity], [-Infinity, 0]),
        ),
        fc.nat(12),
        (xs, bad, pos) => {
          const at = Math.min(pos, xs.length);
          const input = [...xs.slice(0, at), bad, ...xs.slice(at)];
          expect(() => mergeIntervals(input)).toThrow(RangeError);
        },
      ),
    );
  });
});
