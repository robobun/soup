// The ISC License

// Copyright (c) Isaac Z. Schlueter and Contributors

// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.

// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
// IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

import { bunEnv, bunExe } from "harness";
import { unsortedPrereleases } from "./semver-fixture.js";
const { satisfies, order, parse, inc, maxSatisfying, minSatisfying } = Bun.semver;

function testSatisfiesExact(left: any, right: any, expected: boolean) {
  expect(satisfies(left, right)).toBe(expected);
  expect(satisfies(right, left)).toBe(expected);
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  expect(satisfies(leftBuffer, rightBuffer)).toBe(expected);
  expect(satisfies(rightBuffer, leftBuffer)).toBe(expected);
  expect(satisfies(leftBuffer, right)).toBe(expected);
  expect(satisfies(right, leftBuffer)).toBe(expected);
  expect(satisfies(left, rightBuffer)).toBe(expected);
  expect(satisfies(rightBuffer, left)).toBe(expected);
}

function testSatisfies(right: any, left: any, expected: boolean) {
  expect(satisfies(left, right)).toBe(expected);
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  expect(satisfies(leftBuffer, rightBuffer)).toBe(expected);
  expect(satisfies(leftBuffer, right)).toBe(expected);
  expect(satisfies(left, rightBuffer)).toBe(expected);
}

describe("Bun.semver.order()", () => {
  test("whitespace bug fix", () => {
    expect(
      order(
        `1.2.3`,
        `
1.2.3`,
      ),
    ).toBe(0);
    expect(
      order(
        `1.2.3`,
        `\t
1.2.3`,
      ),
    ).toBe(0);
    expect(order("1.2.3", " 1.2.3")).toBe(0);
    expect(order(`\n\t1.2.3`, " 1.2.3")).toBe(0);
    expect(order(`\r\t\n\r1.2.3`, " 1.2.3")).toBe(0);
  });
  // https://github.com/npm/node-semver/blob/14d263faa156e408a033b9b12a2f87735c2df42c/test/fixtures/comparisons.js#L4
  test("comparisons", () => {
    var tests = [
      ["0.0.0", "0.0.0-foo"],
      ["0.0.1", "0.0.0"],
      ["1.0.0", "0.9.9"],
      ["0.10.0", "0.9.0"],
      ["0.99.0", "0.10.0"],
      ["2.0.0", "1.2.3"],
      ["v0.0.0", "0.0.0-foo"],
      ["v0.0.1", "0.0.0"],
      ["v1.0.0", "0.9.9"],
      ["v0.10.0", "0.9.0"],
      ["v0.99.0", "0.10.0"],
      ["v2.0.0", "1.2.3"],
      ["0.0.0", "v0.0.0-foo"],
      ["0.0.1", "v0.0.0"],
      ["1.0.0", "v0.9.9"],
      ["0.10.0", "v0.9.0"],
      ["0.99.0", "v0.10.0"],
      ["2.0.0", "v1.2.3"],
      ["1.2.3", "1.2.3-asdf"],
      ["1.2.3", "1.2.3-4"],
      ["1.2.3", "1.2.3-4-foo"],
      ["1.2.3-5-foo", "1.2.3-5"],
      ["1.2.3-5", "1.2.3-4"],
      ["1.2.3-5-foo", "1.2.3-5-Foo"],
      ["3.0.0", "2.7.2+asdf"],
      ["1.2.3-a.10", "1.2.3-a.5"],
      ["1.2.3-a.b", "1.2.3-a.5"],
      ["1.2.3-a.b", "1.2.3-a"],
      ["1.2.3-a.b.c.10.d.5", "1.2.3-a.b.c.5.d.100"],
      ["1.2.3-r2", "1.2.3-r100"],
      ["1.2.3-r100", "1.2.3-R2"],
      ["1.0.0-pre.a.b", "1.0.0-pre.a"],
      ["1.0.0-alpha.22-alpha.jkwejf334jkj43", "1.0.0-alpha.3"],
      ["1.0.0-alpha.1beta", "1.0.0-alpha.2"],
    ];
    for (const [left, right] of tests) {
      expect(order(left, right)).toBe(1);
      expect(order(right, left)).toBe(-1);
      expect(order(left, left)).toBe(0);
      expect(order(right, right)).toBe(0);
    }
  });

  // not supported by semver, but supported by Bun
  test.each([
    ["0", "0.0"],
    ["1", "1.0"],
    ["1.2", "1.2.0"],
    ["1.x", "1.0.x"],
    ["1.x.x", "1.0.x"],
    ["2.x", "1.x"],
    ["2.x", "2.1"],
    ["2", "1"],
    ["3.*", "3.1"],
    ["3.2.*", "3.2.0"],
    ["4294967295.4294967295.x", "4294967295.4294967295.4294967294"],
    ["*", "4294967295.4294967295.4294967294"],
  ])('loose compare("%s", "%s")', (left, right) => {
    expect(order(left, right)).toBe(1);
    expect(order(right, left)).toBe(-1);
    expect(order(left, left)).toBe(0);
    expect(order(right, right)).toBe(0);
  });

  test("equality", () => {
    // https://github.com/npm/node-semver/blob/14d263faa156e408a033b9b12a2f87735c2df42c/test/fixtures/equality.js#L3
    var tests = [
      ["1.2.3", "v1.2.3"],
      ["1.2.3", "=1.2.3"],
      ["1.2.3", "v 1.2.3"],
      ["1.2.3", "= 1.2.3"],
      ["1.2.3", " v1.2.3"],
      ["1.2.3", " =1.2.3"],
      ["1.2.3", " v 1.2.3"],
      ["1.2.3", " = 1.2.3"],
      ["1.2.3-0", "v1.2.3-0"],
      ["1.2.3-0", "=1.2.3-0"],
      ["1.2.3-0", "v 1.2.3-0"],
      ["1.2.3-0", "= 1.2.3-0"],
      ["1.2.3-0", " v1.2.3-0"],
      ["1.2.3-0", " =1.2.3-0"],
      ["1.2.3-0", " v 1.2.3-0"],
      ["1.2.3-0", " = 1.2.3-0"],
      ["1.2.3-1", "v1.2.3-1"],
      ["1.2.3-1", "=1.2.3-1"],
      ["1.2.3-1", "v 1.2.3-1"],
      ["1.2.3-1", "= 1.2.3-1"],
      ["1.2.3-1", " v1.2.3-1"],
      ["1.2.3-1", " =1.2.3-1"],
      ["1.2.3-1", " v 1.2.3-1"],
      ["1.2.3-1", " = 1.2.3-1"],
      ["1.2.3-beta", "v1.2.3-beta"],
      ["1.2.3-beta", "=1.2.3-beta"],
      ["1.2.3-beta", "v 1.2.3-beta"],
      ["1.2.3-beta", "= 1.2.3-beta"],
      ["1.2.3-beta", " v1.2.3-beta"],
      ["1.2.3-beta", " =1.2.3-beta"],
      ["1.2.3-beta", " v 1.2.3-beta"],
      ["1.2.3-beta", " = 1.2.3-beta"],
      ["1.2.3-beta+build", " = 1.2.3-beta+otherbuild"],
      ["1.2.3+build", " = 1.2.3+otherbuild"],
      ["1.2.3-beta+build", "1.2.3-beta+otherbuild"],
      ["1.2.3+build", "1.2.3+otherbuild"],
      ["  v1.2.3+build", "1.2.3+otherbuild"],

      ["1.1.1-next.0 ", "1.1.1-next.0    "],
      ["1.1.1-next.0.a ", "1.1.1-next.0.a    "],
      ["1.1.1-next.0.a+abc ", "1.1.1-next.0.a+jkejf    "],
    ];

    for (const [left, right] of tests) {
      expect(order(left, right)).toBe(0);
      expect(order(right, left)).toBe(0);
    }
  });
});

describe("Bun.semver.satisfies()", () => {
  test("expected errors", () => {
    expect(satisfies).toBeInstanceOf(Function);
    expect(() => {
      // @ts-expect-error
      satisfies();
    }).toThrow("Expected two arguments");
    expect(() => {
      // @ts-expect-error
      satisfies("1.2.3");
    }).toThrow("Expected two arguments");
    // @ts-expect-error
    expect(satisfies("1.2.3", "1.2.3", "blah")).toBeTrue();
    expect(() => {
      satisfies(Symbol.for("~1.2.3"), "1.2.3");
    }).toThrow("Cannot convert a symbol to a string");
    expect(() => {
      satisfies(Symbol.for("~1.2.3"), Symbol.for("1.2.3"));
    }).toThrow("Cannot convert a symbol to a string");
    expect(() => {
      satisfies("~1.2.3", Symbol.for("1.2.3"));
    }).toThrow("Cannot convert a symbol to a string");
  });

  test("failures does not cause weird memory issues", () => {
    for (let i = 0; i < 1e5; i++) {
      if (!satisfies("1.2.3", "1.2.3")) {
        expect().fail("Expected true");
      }

      if (satisfies("^2.2.3||lol||!!#4_", "1.2.3")) {
        expect().fail("Expected false");
      }

      if (satisfies("^1.2.3||lol||!!#4_", "+!+!+!_)31231.2.3")) {
        expect().fail("Expected false");
      }

      if (!satisfies("1.2.3", "^1.2.3")) {
        expect().fail("Expected true");
      }

      if (satisfies("^1.2.3", "1.2.3")) {
        expect().fail("Expected false");
      }
    }
    Bun.gc(true);
  }, 30_000);

  test("exact versions", () => {
    testSatisfiesExact("1.2.3", "1.2.3", true);
    testSatisfiesExact("4", "4", false);
    testSatisfiesExact("4.0.0", "4.0.0", true);
    testSatisfiesExact("4.0", "4.0", false);
    testSatisfiesExact("5.0.0-beta.1", "5.0.0-beta.1", true);
    testSatisfiesExact("5.0.0-beta.1", "5.0.0-beta.2", false);
    testSatisfiesExact("5.0.0-beta.1", "5.0.0-beta.0", false);
    testSatisfiesExact("5.0.0-beta.1", "5.0.0-beta", false);
    testSatisfiesExact("5.0.0-beta.1", "5.0.0", false);
  });

  test("long version components are not treated as wildcards", () => {
    // A component >20 bytes must parse to its numeric value (or clamp on overflow),
    // not fall through to a wildcard. node-semver loose mode agrees with all of these.
    const twenty = Buffer.alloc(20, "9").toString();
    const twentyOne = Buffer.alloc(21, "9").toString();
    for (const big of [twenty, twentyOne]) {
      testSatisfies("^" + big, "1.0.0", false);
      testSatisfies("^" + big, "5.0.0", false);
      testSatisfies("~" + big, "1.0.0", false);
      testSatisfies("~" + big, "5.0.0", false);
      testSatisfies("~1." + big, "2.0.0", false);
    }
    // 31 bytes but value 5: must be Some(5), not wildcard and not Some(0).
    const padded = Buffer.alloc(30, "0").toString() + "5";
    testSatisfies("^" + padded, "5.2.0", true);
    testSatisfies("^" + padded, "0.5.0", false);
    testSatisfies("^" + padded, "6.0.0", false);
  });

  test("u64::MAX component does not collapse ^/~/x/hyphen ranges to empty", () => {
    // Desugaring these range forms builds an exclusive `< {component+1}` upper bound.
    // At u64::MAX that +1 must not saturate back to MAX (which yields `>=X <X`, an empty range).
    const M = "18446744073709551615";
    const M1 = "18446744073709551614";

    // sanity: version is valid and exactly matchable
    testSatisfies("*", `${M}.0.0`, true);
    testSatisfies(`=${M}.0.0`, `${M}.0.0`, true);
    testSatisfies(`>=${M}.0.0`, `${M}.0.0`, true);

    // caret: major / minor (major==0) / patch (major==0,minor==0)
    testSatisfies(`^${M}`, `${M}.0.0`, true);
    testSatisfies(`^${M}.2.3`, `${M}.5.0`, true);
    testSatisfies(`^0.${M}`, `0.${M}.7`, true);
    testSatisfies(`^0.${M}.3`, `0.${M}.7`, true);
    testSatisfies(`^0.0.${M}`, `0.0.${M}`, true);

    // tilde: major / minor
    testSatisfies(`~${M}`, `${M}.0.0`, true);
    testSatisfies(`~${M}`, `${M}.9.9`, true);
    testSatisfies(`~1.${M}`, `1.${M}.0`, true);
    testSatisfies(`~1.${M}.3`, `1.${M}.3`, true);
    testSatisfies(`~1.${M}.3`, `1.${M}.9`, true);

    // bare partial and x-range (init_wildcard)
    testSatisfies(M, `${M}.0.0`, true);
    testSatisfies(`${M}.x`, `${M}.0.0`, true);
    testSatisfies(`${M}.x`, `${M}.5.0`, true);
    testSatisfies(`1.${M}`, `1.${M}.0`, true);
    testSatisfies(`1.${M}.x`, `1.${M}.5`, true);

    // hyphen range right endpoint (partial)
    testSatisfies(`1.0.0 - ${M}`, `${M}.5.0`, true);
    testSatisfies(`1.0.0 - ${M}.x`, `${M}.5.0`, true);
    testSatisfies(`1.0.0 - 1.${M}`, `1.${M}.5`, true);
    testSatisfies(`1.0.0 - 1.${M}.x`, `1.${M}.5`, true);

    // upper bound is still enforced: the clamped range doesn't leak past its ceiling
    testSatisfies(`^0.${M}`, `1.0.0`, false);
    testSatisfies(`^0.0.${M}`, `0.1.0`, false);
    testSatisfies(`~1.${M}.3`, `2.0.0`, false);
    testSatisfies(`1.${M}.x`, `2.0.0`, false);
    testSatisfies(`1.0.0 - 1.${M}`, `2.0.0`, false);

    // control at MAX-1: every shape already worked and still works
    testSatisfies(`^${M1}`, `${M1}.0.0`, true);
    testSatisfies(`~${M1}`, `${M1}.0.0`, true);
    testSatisfies(M1, `${M1}.0.0`, true);
    testSatisfies(`^${M1}`, `${M}.0.0`, false);
  });

  test("ranges", () => {
    testSatisfies("~1.2.3", "1.2.3", true);
    testSatisfies("~1.2", "1.2.0", true);
    testSatisfies("~1", "1.0.0", true);
    testSatisfies("~1", "1.2.0", true);
    testSatisfies("~1", "1.2.999", true);
    testSatisfies("~0.2.3", "0.2.3", true);
    testSatisfies("~0.2", "0.2.0", true);
    testSatisfies("~0.2", "0.2.1", true);
    testSatisfies("~0 ", "0.0.0", true);

    testSatisfies("~1.2.3", "1.3.0", false);
    testSatisfies("~1.2", "1.3.0", false);
    testSatisfies("~1", "2.0.0", false);
    testSatisfies("~0.2.3", "0.3.0", false);
    testSatisfies("~0.2.3", "1.0.0", false);
    testSatisfies("~0 ", "1.0.0", false);
    testSatisfies("~0.2", "0.1.0", false);
    testSatisfies("~0.2", "0.3.0", false);

    testSatisfies("~3.0.5", "3.3.0", false);

    testSatisfies("^1.1.4", "1.1.4", true);

    testSatisfies(">=3", "3.5.0", true);
    testSatisfies(">=3", "2.999.999", false);
    testSatisfies(">=3", "3.5.1", true);
    testSatisfies(">=3.x.x", "3.x.x", false);

    testSatisfies("<6 >= 5", "5.0.0", true);
    testSatisfies("<6 >= 5", "4.0.0", false);
    testSatisfies("<6 >= 5", "6.0.0", false);
    testSatisfies("<6 >= 5", "6.0.1", false);

    testSatisfies(">2", "3", false);
    testSatisfies(">2", "2.1", false);
    testSatisfies(">2", "2", false);
    testSatisfies(">2", "1.0", false);
    testSatisfies(">1.3", "1.3.1", false);
    testSatisfies(">1.3", "2.0.0", true);
    testSatisfies(">2.1.0", "2.2.0", true);
    testSatisfies("<=2.2.99999", "2.2.0", true);
    testSatisfies(">=2.1.99999", "2.2.0", true);
    testSatisfies("<2.2.99999", "2.2.0", true);
    testSatisfies(">2.1.99999", "2.2.0", true);
    testSatisfies(">1.0.0", "2.0.0", true);
    testSatisfies("1.0.0", "1.0.0", true);
    testSatisfies("1.0.0", "2.0.0", false);

    testSatisfies("1.0.0 || 2.0.0", "1.0.0", true);
    testSatisfies("2.0.0 || 1.0.0", "1.0.0", true);
    testSatisfies("1.0.0 || 2.0.0", "2.0.0", true);
    testSatisfies("2.0.0 || 1.0.0", "2.0.0", true);
    testSatisfies("2.0.0 || >1.0.0", "2.0.0", true);

    testSatisfies(">1.0.0 <2.0.0 <2.0.1 >1.0.1", "1.0.2", true);

    testSatisfies("2.x", "2.0.0", true);
    testSatisfies("2.x", "2.1.0", true);
    testSatisfies("2.x", "2.2.0", true);
    testSatisfies("2.x", "2.3.0", true);
    testSatisfies("2.x", "2.1.1", true);
    testSatisfies("2.x", "2.2.2", true);
    testSatisfies("2.x", "2.3.3", true);

    testSatisfies("<2.0.1 >1.0.0", "2.0.0", true);
    testSatisfies("<=2.0.1 >=1.0.0", "2.0.0", true);

    testSatisfies("^2", "2.0.0", true);
    testSatisfies("^2", "2.9.9", true);
    testSatisfies("~2", "2.0.0", true);
    testSatisfies("~2", "2.1.0", true);
    testSatisfies("~2.2", "2.2.1", true);

    testSatisfies("2.1.0 || > 2.2 || >3", "2.1.0", true);
    testSatisfies(" > 2.2 || >3 || 2.1.0", "2.1.0", true);
    testSatisfies(" > 2.2 || 2.1.0 || >3", "2.1.0", true);
    testSatisfies("> 2.2 || 2.1.0 || >3", "2.3.0", true);
    testSatisfies("> 2.2 || 2.1.0 || >3", "2.2.1", false);
    testSatisfies("> 2.2 || 2.1.0 || >3", "2.2.0", false);
    testSatisfies("> 2.2 || 2.1.0 || >3", "2.3.0", true);
    testSatisfies("> 2.2 || 2.1.0 || >3", "3.0.1", true);
    testSatisfies("~2", "2.0.0", true);
    testSatisfies("~2", "2.1.0", true);

    testSatisfies("1.2.0 - 1.3.0", "1.2.2", true);
    testSatisfies("1.2 - 1.3", "1.2.2", true);
    testSatisfies("1 - 1.3", "1.2.2", true);
    testSatisfies("1 - 1.3", "1.3.0", true);
    testSatisfies("1.2 - 1.3", "1.3.1", true);
    testSatisfies("1.2 - 1.3", "1.4.0", false);
    testSatisfies("1 - 1.3", "1.3.1", true);

    testSatisfies("1.2 - 1.3 || 5.0", "6.4.0", false);
    testSatisfies("1.2 - 1.3 || 5.0", "1.2.1", true);
    testSatisfies("5.0 || 1.2 - 1.3", "1.2.1", true);
    testSatisfies("1.2 - 1.3 || 5.0", "5.0", false);
    testSatisfies("5.0 || 1.2 - 1.3", "5.0", false);
    testSatisfies("1.2 - 1.3 || 5.0", "5.0.2", true);
    testSatisfies("5.0 || 1.2 - 1.3", "5.0.2", true);
    testSatisfies("1.2 - 1.3 || 5.0", "5.0.2", true);
    testSatisfies("5.0 || 1.2 - 1.3", "5.0.2", true);
    testSatisfies("5.0 || 1.2 - 1.3 || >8", "9.0.2", true);

    testSatisfies(">=0.34.0-next.3 <1.0.0", "0.34.0-next.8", true);
    testSatisfies("<1.0.0", "0.34.0-next.8", false);

    testSatisfies("<=7.0.0", "7.0.0-rc2", false);
    testSatisfies(">=7.0.0", "7.0.0-rc2", false);
    testSatisfies("<=7.0.0-rc2", "7.0.0-rc2", true);
    testSatisfies(">=7.0.0-rc2", "7.0.0-rc2", true);

    testSatisfies("^1.2.3-pr.1 || >=1.2.4-alpha", "1.2.4-alpha.notready", true);

    testSatisfies("^3.0.0-next.0||^3.0.0", "3.0.0-next.2", true);

    const notPassing = [
      "0.1.0",
      "0.10.0",
      "0.2.0",
      "0.2.1",
      "0.2.2",
      "0.3.0",
      "0.3.1",
      "0.3.2",
      "0.4.0",
      "0.4.1",
      "0.4.2",
      "0.5.0",
      "0.5.0-rc.1",
      "0.5.1",
      "0.5.2",
      "0.6.0",
      "0.6.1",
      "0.7.0",
      "0.8.0",
      "0.8.1",
      "0.8.2",
      "0.9.0",
      "0.9.1",
      "0.9.2",
      "1.0.0",
      "1.0.1",
      "1.0.2",
      "1.1.0",
      "1.1.1",
      "1.2.0",
      "1.2.1",
      "1.3.0",
      "1.3.1",
      "2.2.0",
      "2.2.1",
      "2.3.0",
      "1.0.0-rc.1",
      "1.0.0-rc.2",
      "1.0.0-rc.3",
    ];

    for (const item of notPassing) {
      testSatisfies("^2 <2.2 || > 2.3", item, false);
      testSatisfies("> 2.3 || ^2 <2.2", item, false);
    }

    const passing = [
      "2.4.0",
      "2.4.1",
      "3.0.0",
      "3.0.1",
      "3.1.0",
      "3.2.0",
      "3.3.0",
      "3.3.1",
      "3.4.0",
      "3.5.0",
      "3.6.0",
      "3.7.0",
      "2.4.2",
      "3.8.0",
      "3.9.0",
      "3.9.1",
      "3.9.2",
      "3.9.3",
      "3.10.0",
      "3.10.1",
      "4.0.0",
      "4.0.1",
      "4.1.0",
      "4.2.0",
      "4.2.1",
      "4.3.0",
      "4.4.0",
      "4.5.0",
      "4.5.1",
      "4.6.0",
      "4.6.1",
      "4.7.0",
      "4.8.0",
      "4.8.1",
      "4.8.2",
      "4.9.0",
      "4.10.0",
      "4.11.0",
      "4.11.1",
      "4.11.2",
      "4.12.0",
      "4.13.0",
      "4.13.1",
      "4.14.0",
      "4.14.1",
      "4.14.2",
      "4.15.0",
      "4.16.0",
      "4.16.1",
      "4.16.2",
      "4.16.3",
      "4.16.4",
      "4.16.5",
      "4.16.6",
      "4.17.0",
      "4.17.1",
      "4.17.2",
      "4.17.3",
      "4.17.4",
      "4.17.5",
      "4.17.9",
      "4.17.10",
      "4.17.11",
      "2.0.0",
      "2.1.0",
    ];

    for (const item of passing) {
      testSatisfies("^2 <2.2 || > 2.3", item, true);
      testSatisfies("> 2.3 || ^2 <2.2", item, true);
    }
  });

  test("range includes", () => {
    // https://github.com/npm/node-semver/blob/14d263faa156e408a033b9b12a2f87735c2df42c/test/fixtures/range-include.js#L3
    var tests = [
      ["1.0.0 - 2.0.0", "1.2.3"],
      ["^1.2.3+build", "1.2.3"],
      ["^1.2.3+build", "1.3.0"],
      ["1.2.3-pre+asdf - 2.4.3-pre+asdf", "1.2.3"],
      ["1.2.3pre+asdf - 2.4.3-pre+asdf", "1.2.3"],
      ["1.2.3-pre+asdf - 2.4.3pre+asdf", "1.2.3"],
      ["1.2.3pre+asdf - 2.4.3pre+asdf", "1.2.3"],
      ["1.2.3-pre+asdf - 2.4.3-pre+asdf", "1.2.3-pre.2"],
      ["1.2.3-pre+asdf - 2.4.3-pre+asdf", "2.4.3-alpha"],
      ["1.2.3+asdf - 2.4.3+asdf", "1.2.3"],
      ["1.0.0", "1.0.0"],
      [">=*", "0.2.4"],
      ["", "1.0.0"],
      ["*", "1.2.3"],
      ["*", "v1.2.3"],
      [">=1.0.0", "1.0.0"],
      [">=1.0.0", "1.0.1"],
      [">=1.0.0", "1.1.0"],
      [">1.0.0", "1.0.1"],
      [">1.0.0", "1.1.0"],
      ["<=2.0.0", "2.0.0"],
      ["<=2.0.0", "1.9999.9999"],
      ["<=2.0.0", "0.2.9"],
      ["<2.0.0", "1.9999.9999"],
      ["<2.0.0", "0.2.9"],
      [">= 1.0.0", "1.0.0"],
      [">=  1.0.0", "1.0.1"],
      [">=   1.0.0", "1.1.0"],
      ["> 1.0.0", "1.0.1"],
      [">  1.0.0", "1.1.0"],
      ["<=   2.0.0", "2.0.0"],
      ["<= 2.0.0", "1.9999.9999"],
      ["<=  2.0.0", "0.2.9"],
      ["<    2.0.0", "1.9999.9999"],
      ["<\t2.0.0", "0.2.9"],
      [">=0.1.97", "v0.1.97", true],
      [">=0.1.97", "0.1.97"],
      ["0.1.20 || 1.2.4", "1.2.4"],
      [">=0.2.3 || <0.0.1", "0.0.0"],
      [">=0.2.3 || <0.0.1", "0.2.3"],
      [">=0.2.3 || <0.0.1", "0.2.4"],
      ["||", "1.3.4"],
      ["2.x.x", "2.1.3"],
      ["1.2.x", "1.2.3"],
      ["1.2.x || 2.x", "2.1.3"],
      ["1.2.x || 2.x", "1.2.3"],
      ["x", "1.2.3"],
      ["2.*.*", "2.1.3"],
      ["1.2.*", "1.2.3"],
      ["1.2.* || 2.*", "2.1.3"],
      ["1.2.* || 2.*", "1.2.3"],
      ["*", "1.2.3"],
      ["2", "2.1.2"],
      ["2.3", "2.3.1"],
      ["~0.0.1", "0.0.1"],
      ["~0.0.1", "0.0.2"],
      ["~x", "0.0.9"], // >=2.4.0 <2.5.0
      ["~2", "2.0.9"], // >=2.4.0 <2.5.0
      ["~2.4", "2.4.0"], // >=2.4.0 <2.5.0
      ["~2.4", "2.4.5"],
      ["~>3.2.1", "3.2.2"], // >=3.2.1 <3.3.0,
      ["~1", "1.2.3"], // >=1.0.0 <2.0.0
      ["~>1", "1.2.3"],
      ["~> 1", "1.2.3"],
      ["~1.0", "1.0.2"], // >=1.0.0 <1.1.0,
      ["~ 1.0", "1.0.2"],
      ["~ 1.0.3", "1.0.12"],
      ["~ 1.0.3alpha", "1.0.12"],
      [">=1", "1.0.0"],
      [">= 1", "1.0.0"],
      ["<1.2", "1.1.1"],
      ["< 1.2", "1.1.1"],
      ["~v0.5.4-pre", "0.5.5"],
      ["~v0.5.4-pre", "0.5.4"],
      ["=0.7.x", "0.7.2"],
      ["<=0.7.x", "0.7.2"],
      [">=0.7.x", "0.7.2"],
      ["<=0.7.x", "0.6.2"],
      ["~1.2.1 >=1.2.3", "1.2.3"],
      ["~1.2.1 =1.2.3", "1.2.3"],
      ["~1.2.1 1.2.3", "1.2.3"],
      ["~1.2.1 >=1.2.3 1.2.3", "1.2.3"],
      ["~1.2.1 1.2.3 >=1.2.3", "1.2.3"],
      [">=1.2.1 1.2.3", "1.2.3"],
      ["1.2.3 >=1.2.1", "1.2.3"],
      [">=1.2.3 >=1.2.1", "1.2.3"],
      [">=1.2.1 >=1.2.3", "1.2.3"],
      [">=1.2", "1.2.8"],
      ["^1.2.3", "1.8.1"],
      ["^0.1.2", "0.1.2"],
      ["^0.1", "0.1.2"],
      ["^0.0.1", "0.0.1"],
      ["^1.2", "1.4.2"],
      ["^1.2 ^1", "1.4.2"],
      ["^1.2.3-alpha", "1.2.3-pre"],
      ["^1.2.0-alpha", "1.2.0-pre"],
      ["^0.0.1-alpha", "0.0.1-beta"],
      ["^0.0.1-alpha", "0.0.1"],
      ["^0.1.1-alpha", "0.1.1-beta"],
      ["^x", "1.2.3"],
      ["x - 1.0.0", "0.9.7"],
      ["x - 1.x", "0.9.7"],
      ["1.0.0 - x", "1.9.7"],
      ["1.0.0 - x", "1.0.7"],
      ["1.0.0 - 1.x", "1.0.7"],
      ["1.0.0 - 1.0.x", "1.0.7"],
      ["1.x - x", "1.9.7"],
      ["<=7.x", "7.9.9"],

      // ["2.x", "2.0.0-pre.0", { includePrerelease: true }],
      // ["2.x", "2.1.0-pre.0", { includePrerelease: true }],
      // ["1.1.x", "1.1.0-a", { includePrerelease: true }],
      // ["1.1.x", "1.1.1-a", { includePrerelease: true }],
      // ["*", "1.0.0-rc1", { includePrerelease: true }],
      // ["^1.0.0-0", "1.0.1-rc1", { includePrerelease: true }],
      // ["^1.0.0-rc2", "1.0.1-rc1", { includePrerelease: true }],
      // ["^1.0.0", "1.0.1-rc1", { includePrerelease: true }],
      // ["^1.0.0", "1.1.0-rc1", { includePrerelease: true }],
      // ["1 - 2", "2.0.0-pre", { includePrerelease: true }],
      // ["1 - 2", "1.0.0-pre", { includePrerelease: true }],
      // ["1.0 - 2", "1.0.0-pre", { includePrerelease: true }],

      // ["=0.7.x", "0.7.0-asdf", { includePrerelease: true }],
      // [">=0.7.x", "0.7.0-asdf", { includePrerelease: true }],
      // ["<=0.7.x", "0.7.0-asdf", { includePrerelease: true }],

      // [">=1.0.0 <=1.1.0", "1.1.0-pre", { includePrerelease: true }],

      // https://github.com/oven-sh/bun/issues/8040
      [">=3.3.0-beta.1 <3.4.0-beta.3", "3.3.1"],
      ["^3.3.0-beta.1", "3.4.0"],
    ];

    for (const [range, version] of tests) {
      expect(satisfies(version, range)).toBeTrue();
    }
  });

  test("range excludes", () => {
    // https://github.com/npm/node-semver/blob/14d263faa156e408a033b9b12a2f87735c2df42c/test/fixtures/range-exclude.js#L3
    const tests = [
      ["1.0.0 - 2.0.0", "2.2.3"],
      ["1.2.3+asdf - 2.4.3+asdf", "1.2.3-pre.2"],
      ["1.2.3+asdf - 2.4.3+asdf", "2.4.3-alpha"],
      ["^1.2.3+build", "2.0.0"],
      ["^1.2.3+build", "1.2.0"],
      ["^1.2.3", "1.2.3-pre"],
      ["^1.2", "1.2.0-pre"],
      [">1.2", "1.3.0-beta"],
      ["<=1.2.3", "1.2.3-beta"],
      ["^1.2.3", "1.2.3-beta"],
      ["=0.7.x", "0.7.0-asdf"],
      [">=0.7.x", "0.7.0-asdf"],
      ["<=0.7.x", "0.7.0-asdf"],
      ["1", "1.0.0beta"],
      ["<1", "1.0.0beta"],
      ["< 1", "1.0.0beta"],
      ["1.0.0", "1.0.1"],
      [">=1.0.0", "0.0.0"],
      [">=1.0.0", "0.0.1"],
      [">=1.0.0", "0.1.0"],
      [">1.0.0", "0.0.1"],
      [">1.0.0", "0.1.0"],
      ["<=2.0.0", "3.0.0"],
      ["<=2.0.0", "2.9999.9999"],
      ["<=2.0.0", "2.2.9"],
      ["<2.0.0", "2.9999.9999"],
      ["<2.0.0", "2.2.9"],
      [">=0.1.97", "v0.1.93"],
      [">=0.1.97", "0.1.93"],
      ["0.1.20 || 1.2.4", "1.2.3"],
      [">=0.2.3 || <0.0.1", "0.0.3"],
      [">=0.2.3 || <0.0.1", "0.2.2"],
      ["2.x.x", "1.1.3"],
      ["2.x.x", "3.1.3"],
      ["1.2.x", "1.3.3"],
      ["1.2.x || 2.x", "3.1.3"],
      ["1.2.x || 2.x", "1.1.3"],
      ["2.*.*", "1.1.3"],
      ["2.*.*", "3.1.3"],
      ["1.2.*", "1.3.3"],
      ["1.2.* || 2.*", "3.1.3"],
      ["1.2.* || 2.*", "1.1.3"],
      ["2", "1.1.2"],
      ["2.3", "2.4.1"],
      ["~0.0.1", "0.1.0-alpha"],
      ["~0.0.1", "0.1.0"],
      ["~2.4", "2.5.0"], // >=2.4.0 <2.5.0
      ["~2.4", "2.3.9"],
      ["~>3.2.1", "3.3.2"], // >=3.2.1 <3.3.0
      ["~>3.2.1", "3.2.0"], // >=3.2.1 <3.3.0
      ["~1", "0.2.3"], // >=1.0.0 <2.0.0
      ["~>1", "2.2.3"],
      ["~1.0", "1.1.0"], // >=1.0.0 <1.1.0
      ["<1", "1.0.0"],
      [">=1.2", "1.1.1"],
      ["1", "2.0.0beta"],
      ["~v0.5.4-beta", "0.5.4-alpha"],
      ["=0.7.x", "0.8.2"],
      [">=0.7.x", "0.6.2"],
      ["<0.7.x", "0.7.2"],
      ["<1.2.3", "1.2.3-beta"],
      ["=1.2.3", "1.2.3-beta"],
      [">1.2", "1.2.8"],
      ["^0.0.1", "0.0.2-alpha"],
      ["^0.0.1", "0.0.2"],
      ["^1.2.3", "2.0.0-alpha"],
      ["^1.2.3", "1.2.2"],
      ["^1.2", "1.1.9"],
      ["*", "v1.2.3-foo"],

      // invalid versions never satisfy, but shouldn't throw
      ["*", "not a version"],
      [">=2", "glorp"],
      [">=2", false],

      // ["2.x", "3.0.0-pre.0", { includePrerelease: true }],
      // ["^1.0.0", "1.0.0-rc1", { includePrerelease: true }],
      // ["^1.0.0", "2.0.0-rc1", { includePrerelease: true }],
      // ["^1.2.3-rc2", "2.0.0", { includePrerelease: true }],
      ["^1.0.0", "2.0.0-rc1"],

      // ["1 - 2", "3.0.0-pre", { includePrerelease: true }],
      ["1 - 2", "2.0.0-pre"],
      ["1 - 2", "1.0.0-pre"],
      ["1.0 - 2", "1.0.0-pre"],

      ["1.1.x", "1.0.0-a"],
      ["1.1.x", "1.1.0-a"],
      ["1.1.x", "1.2.0-a"],
      // ["1.1.x", "1.2.0-a", { includePrerelease: true }],
      // ["1.1.x", "1.0.0-a", { includePrerelease: true }],
      ["1.x", "1.0.0-a"],
      ["1.x", "1.1.0-a"],
      ["1.x", "1.2.0-a"],
      // ["1.x", "0.0.0-a", { includePrerelease: true }],
      // ["1.x", "2.0.0-a", { includePrerelease: true }],

      [">=1.0.0 <1.1.0", "1.1.0"],
      // [">=1.0.0 <1.1.0", "1.1.0", { includePrerelease: true }],
      [">=1.0.0 <1.1.0", "1.1.0-pre"],
      [">=1.0.0 <1.1.0-pre", "1.1.0-pre"],

      ["== 1.0.0 || foo", "2.0.0"],

      // https://github.com/oven-sh/bun/issues/8040
      [">=3.3.0-beta.1 <3.4.0-beta.3", "3.4.5"],
    ];

    for (const [range, version] of tests) {
      expect(satisfies(version, range)).toBeFalse();
    }
  });

  test("pre-release snapshot", () => {
    expect(unsortedPrereleases.sort(Bun.semver.order)).toMatchSnapshot();
  });
});

describe("Bun.semver.parse()", () => {
  test("release version", () => {
    expect(parse("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
      version: "1.2.3",
    });
    expect(parse("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0, prerelease: [], build: [], version: "0.0.0" });
    expect(parse("2024.12.31")).toEqual({
      major: 2024,
      minor: 12,
      patch: 31,
      prerelease: [],
      build: [],
      version: "2024.12.31",
    });
  });

  test("prerelease and build metadata", () => {
    expect(parse("v1.2.3-beta.1+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", 1],
      build: ["build", "5"],
      version: "1.2.3-beta.1",
    });
    expect(parse("1.0.0-beta+exp.sha.5114f85")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["beta"],
      build: ["exp", "sha", "5114f85"],
      version: "1.0.0-beta",
    });
    expect(parse("1.0.0+20130313144700")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
      build: ["20130313144700"],
      version: "1.0.0",
    });
  });

  test("prerelease identifiers", () => {
    expect(parse("1.0.0-alpha")!.prerelease).toEqual(["alpha"]);
    expect(parse("1.0.0-alpha.1")!.prerelease).toEqual(["alpha", 1]);
    expect(parse("1.0.0-0.3.7")!.prerelease).toEqual([0, 3, 7]);
    expect(parse("1.0.0-x.7.z.92")!.prerelease).toEqual(["x", 7, "z", 92]);
    expect(parse("1.0.0-alpha-2.b-3")!.prerelease).toEqual(["alpha-2", "b-3"]);
    expect(parse("1.0.0-rc.9007199254740991")!.prerelease).toEqual(["rc", Number.MAX_SAFE_INTEGER]);
    // Too big to be an exact number, so it stays a string instead of losing digits.
    expect(parse("1.0.0-rc.9007199254740992")!.prerelease).toEqual(["rc", "9007199254740992"]);
    expect(parse("1.0.0-rc.99999999999999999999999")!.prerelease).toEqual(["rc", "99999999999999999999999"]);
    // Build identifiers are never converted.
    expect(parse("1.0.0+1.2")!.build).toEqual(["1", "2"]);
  });

  test("ignores the same prefixes and whitespace as order() and satisfies()", () => {
    const expected = parse("1.2.3-rc.1");
    expect(expected).not.toBeNull();
    for (const input of ["v1.2.3-rc.1", "=1.2.3-rc.1", " 1.2.3-rc.1", "1.2.3-rc.1\n", "\t v1.2.3-rc.1 \r\n"]) {
      expect(parse(input)).toEqual(expected!);
    }
  });

  test("stringifies non-string input", () => {
    expect(parse(Buffer.from("1.2.3"))).toEqual(parse("1.2.3")!);
    expect(parse({ toString: () => "4.5.6" })).toEqual(parse("4.5.6")!);
    expect(() => parse(Symbol.for("1.2.3") as any)).toThrow("Cannot convert a symbol to a string");
  });

  test("returns null for anything that is not a complete version", () => {
    const invalid = [
      "",
      " ",
      "v",
      "1",
      "1.2",
      "1.2.",
      "1.2.3.4",
      "x",
      "*",
      "1.x",
      "1.2.x",
      "1.2.*",
      "^1.2.3",
      "~1.2.3",
      ">=1.2.3",
      "1.2.3 || 2.0.0",
      "1.2.3 - 2.0.0",
      "1.2.3 trailing",
      "-beta",
      "nope",
      "1.2.3-\u00df",
    ];
    for (const input of invalid) {
      expect(parse(input)).toBeNull();
    }
    expect(parse(undefined)).toBeNull();
    expect(parse(null)).toBeNull();
    // @ts-expect-error
    expect(parse()).toBeNull();
  });

  test("round-trips through order()", () => {
    const mismatches = unsortedPrereleases.filter(input => {
      const parsed = parse(input);
      if (parsed === null || order(parsed.version, input) !== 0) return true;
      // `version` drops build metadata, everything else survives the round trip.
      return !Bun.deepEquals(parse(parsed.version), { ...parsed, build: [] }, true);
    });
    expect(mismatches).toEqual([]);
  });
});

describe("Bun.semver.inc()", () => {
  type Release = Bun.semver.ReleaseType;
  type Case = [
    version: string,
    release: Release,
    expected: string | null,
    identifier?: string,
    base?: "0" | "1" | false,
  ];

  // https://github.com/npm/node-semver/blob/main/test/fixtures/increments.js, minus the
  // `loose` cases. Same expectations, so `Bun.semver.inc` is a drop-in for `semver.inc`.
  const increments: Case[] = [
    ["1.2.3", "major", "2.0.0"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "patch", "1.2.4"],
    ["1.2.3-tag", "major", "2.0.0"],
    ["1.2.0-0", "patch", "1.2.0"],
    ["1.2.3-4", "major", "2.0.0"],
    ["1.2.3-4", "minor", "1.3.0"],
    ["1.2.3-4", "patch", "1.2.3"],
    ["1.2.3-alpha.0.beta", "major", "2.0.0"],
    ["1.2.3-alpha.0.beta", "minor", "1.3.0"],
    ["1.2.3-alpha.0.beta", "patch", "1.2.3"],
    ["1.2.4", "prerelease", "1.2.5-0"],
    ["1.2.3-0", "prerelease", "1.2.3-1"],
    ["1.2.3-alpha.0", "prerelease", "1.2.3-alpha.1"],
    ["1.2.3-alpha.1", "prerelease", "1.2.3-alpha.2"],
    ["1.2.3-alpha.2", "prerelease", "1.2.3-alpha.3"],
    ["1.2.3-alpha.0.beta", "prerelease", "1.2.3-alpha.1.beta"],
    ["1.2.3-alpha.1.beta", "prerelease", "1.2.3-alpha.2.beta"],
    ["1.2.3-alpha.2.beta", "prerelease", "1.2.3-alpha.3.beta"],
    ["1.2.3-alpha.10.0.beta", "prerelease", "1.2.3-alpha.10.1.beta"],
    ["1.2.3-alpha.10.1.beta", "prerelease", "1.2.3-alpha.10.2.beta"],
    ["1.2.3-alpha.10.2.beta", "prerelease", "1.2.3-alpha.10.3.beta"],
    ["1.2.3-alpha.10.beta.0", "prerelease", "1.2.3-alpha.10.beta.1"],
    ["1.2.3-alpha.10.beta.1", "prerelease", "1.2.3-alpha.10.beta.2"],
    ["1.2.3-alpha.10.beta.2", "prerelease", "1.2.3-alpha.10.beta.3"],
    ["1.2.3-alpha.9.beta", "prerelease", "1.2.3-alpha.10.beta"],
    ["1.2.3-alpha.10.beta", "prerelease", "1.2.3-alpha.11.beta"],
    ["1.2.3-alpha.11.beta", "prerelease", "1.2.3-alpha.12.beta"],
    ["1.2.0", "prepatch", "1.2.1-0"],
    ["1.2.0-1", "prepatch", "1.2.1-0"],
    ["1.2.0", "preminor", "1.3.0-0"],
    ["1.2.3-1", "preminor", "1.3.0-0"],
    ["1.2.0", "premajor", "2.0.0-0"],
    ["1.2.3-1", "premajor", "2.0.0-0"],
    ["1.2.0-1", "minor", "1.2.0"],
    ["1.0.0-1", "major", "1.0.0"],
    ["1.2.3-dev.bar", "prerelease", "1.2.3-dev.0", "dev"],

    ["1.2.3", "major", "2.0.0", "dev"],
    ["1.2.3", "minor", "1.3.0", "dev"],
    ["1.2.3", "patch", "1.2.4", "dev"],
    ["1.2.3-tag", "major", "2.0.0", "dev"],
    ["1.2.0-0", "patch", "1.2.0", "dev"],
    ["1.2.3-4", "major", "2.0.0", "dev"],
    ["1.2.3-4", "minor", "1.3.0", "dev"],
    ["1.2.3-4", "patch", "1.2.3", "dev"],
    ["1.2.3-alpha.0.beta", "major", "2.0.0", "dev"],
    ["1.2.3-alpha.0.beta", "minor", "1.3.0", "dev"],
    ["1.2.3-alpha.0.beta", "patch", "1.2.3", "dev"],
    ["1.2.4", "prerelease", "1.2.5-dev.0", "dev"],
    ["1.2.3-0", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.0", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.0", "prerelease", "1.2.3-alpha.1", "alpha"],
    ["1.2.3-alpha.0.beta", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.0.beta", "prerelease", "1.2.3-alpha.1.beta", "alpha"],
    ["1.2.3-alpha.10.0.beta", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.10.0.beta", "prerelease", "1.2.3-alpha.10.1.beta", "alpha"],
    ["1.2.3-alpha.10.1.beta", "prerelease", "1.2.3-alpha.10.2.beta", "alpha"],
    ["1.2.3-alpha.10.2.beta", "prerelease", "1.2.3-alpha.10.3.beta", "alpha"],
    ["1.2.3-alpha.10.beta.0", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.10.beta.0", "prerelease", "1.2.3-alpha.10.beta.1", "alpha"],
    ["1.2.3-alpha.10.beta.1", "prerelease", "1.2.3-alpha.10.beta.2", "alpha"],
    ["1.2.3-alpha.10.beta.2", "prerelease", "1.2.3-alpha.10.beta.3", "alpha"],
    ["1.2.3-alpha.9.beta", "prerelease", "1.2.3-dev.0", "dev"],
    ["1.2.3-alpha.9.beta", "prerelease", "1.2.3-alpha.10.beta", "alpha"],
    ["1.2.3-alpha.10.beta", "prerelease", "1.2.3-alpha.11.beta", "alpha"],
    ["1.2.3-alpha.11.beta", "prerelease", "1.2.3-alpha.12.beta", "alpha"],
    ["1.2.0", "prepatch", "1.2.1-dev.0", "dev"],
    ["1.2.0-1", "prepatch", "1.2.1-dev.0", "dev"],
    ["1.2.0", "preminor", "1.3.0-dev.0", "dev"],
    ["1.2.3-1", "preminor", "1.3.0-dev.0", "dev"],
    ["1.2.0", "premajor", "2.0.0-dev.0", "dev"],
    ["1.2.3-1", "premajor", "2.0.0-dev.0", "dev"],
    ["1.2.0-1", "minor", "1.2.0", "dev"],
    ["1.0.0-1", "major", "1.0.0", "dev"],

    // identifierBase
    ["1.2.0", "prepatch", "1.2.1-dev.1", "dev", "1"],
    ["1.2.0-1", "prepatch", "1.2.1-dev.1", "dev", "1"],
    ["1.2.0", "preminor", "1.3.0-dev.1", "dev", "1"],
    ["1.2.3-1", "preminor", "1.3.0-dev.1", "dev", "1"],
    ["1.2.0", "premajor", "2.0.0-dev.1", "dev", "1"],
    ["1.2.3-1", "premajor", "2.0.0-dev.1", "dev", "1"],
    ["1.2.0-1", "minor", "1.2.0", "dev", "1"],
    ["1.0.0-1", "major", "1.0.0", "dev", "1"],
    ["1.2.3-dev.bar", "prerelease", "1.2.3-dev.1", "dev", "1"],
    ["1.2.4", "prerelease", "1.2.5-1", "", "1"],
    ["1.2.4", "prerelease", "1.2.5-0", "", "0"],
    ["1.2.3-alpha.0", "prerelease", "1.2.3-alpha.1", "alpha", "1"],
    ["1.2.3-alpha.0", "prerelease", "1.2.3-dev.1", "dev", "1"],
    // `false`: no number
    ["1.2.0", "prepatch", "1.2.1-dev", "dev", false],
    ["1.2.0", "preminor", "1.3.0-dev", "dev", false],
    ["1.2.0", "premajor", "2.0.0-dev", "dev", false],
    ["1.2.3", "prerelease", "1.2.4-alpha", "alpha", false],
    ["1.2.3-dev.bar", "prerelease", "1.2.3-alpha", "alpha", false],
    ["1.2.3-alpha.1", "prerelease", "1.2.3-alpha.2", "alpha", false],
    // `1.2.3-alpha` is already the prerelease `alpha` with no number.
    ["1.2.3-alpha", "prerelease", null, "alpha", false],
    // Nothing to put after the `-`.
    ["1.2.3", "prerelease", null, undefined, false],
    ["1.2.3", "premajor", null, "", false],

    // release
    ["1.2.3", "release", null],
    ["1.2.3-alpha", "release", "1.2.3"],
    ["1.2.3-alpha.1", "release", "1.2.3"],
    ["1.2.3-alpha.1", "release", "1.2.3", "alpha"],
    ["1.2.3-alpha.1", "release", "1.2.3", "alpha", "1"],
    ["1.2.3-alpha.1+build.5", "release", "1.2.3"],
  ];

  // A rest parameter, so that bun:test does not take the shorter rows as a request for `done`.
  test.each(increments)(
    "inc(%j, %j) is %j (identifier %j, base %j)",
    (...[version, release, expected, identifier, base]) => {
      expect(inc(version, release, identifier, base)).toBe(expected);
    },
  );

  test("returns null for anything that is not a complete version", () => {
    for (const input of ["", "fake", "1.2", "1.x", "^1.2.3", "1.2.3 || 2.0.0", "1.2.3 trailing", "1.2.3-\u00df"]) {
      expect(inc(input, "patch")).toBeNull();
      expect(inc(input, "prerelease", "beta")).toBeNull();
    }
    expect(inc(undefined, "patch")).toBeNull();
    expect(inc(null, "patch")).toBeNull();
  });

  test("accepts the same prefixes and whitespace as parse()", () => {
    for (const input of ["v1.2.3", "=1.2.3", " 1.2.3", "1.2.3 ", "\t v1.2.3 "]) {
      expect(inc(input, "patch")).toBe("1.2.4");
    }
    for (const input of ["v1.2.3-rc.1", "=1.2.3-rc.1", "1.2.3-rc.1\n", "\t v1.2.3-rc.1 \r\n"]) {
      expect(inc(input, "prerelease")).toBe("1.2.3-rc.2");
    }
    expect(inc(Buffer.from("1.2.3"), "minor")).toBe("1.3.0");
    expect(inc({ toString: () => "4.5.6" }, "major")).toBe("5.0.0");
  });

  test("drops build metadata", () => {
    expect(inc("1.2.3+build.5", "patch")).toBe("1.2.4");
    expect(inc("1.2.3-beta.1+sha.abc", "prerelease")).toBe("1.2.3-beta.2");
  });

  test("counts up the numeric identifiers parse() reports as numbers", () => {
    expect(inc("1.2.3-beta.9007199254740991", "prerelease")).toBe("1.2.3-beta.9007199254740992");
    // Too big to be a number, so it stays text and a new number is started.
    expect(inc("1.2.3-beta.9007199254740992", "prerelease")).toBe("1.2.3-beta.9007199254740992.0");
    expect(inc("1.2.3-beta.01", "prerelease")).toBe("1.2.3-beta.2");
  });

  test("an identifier must be a valid prerelease identifier", () => {
    expect(inc("1.2.3", "prerelease", "beta.rc")).toBe("1.2.4-beta.rc.0");
    expect(inc("1.2.3", "prerelease", "0")).toBe("1.2.4-0.0");
    expect(inc("1.2.3", "prerelease", "build-2024")).toBe("1.2.4-build-2024.0");
    for (const invalid of ["beta!", "beta rc", "01", "beta.", ".beta", "beta..rc", "bêta", "beta+1"]) {
      expect(inc("1.2.3", "prerelease", invalid)).toBeNull();
      expect(inc("1.2.3", "premajor", invalid)).toBeNull();
    }
    // Like node-semver, the identifier is not looked at unless the release type is a prerelease one.
    expect(inc("1.2.3", "patch", "beta!")).toBe("1.2.4");
  });

  test("argument validation", () => {
    // @ts-expect-error
    expect(() => inc("1.2.3")).toThrow(TypeError);
    // @ts-expect-error
    expect(() => inc("1.2.3", "bump")).toThrow('`release` must be one of "major", "minor"');
    // A bad release type is reported even when the version is not valid.
    // @ts-expect-error
    expect(() => inc("nope", "bump")).toThrow(TypeError);
    // @ts-expect-error
    expect(() => inc("1.2.3", "prerelease", 5)).toThrow("`identifier` must be a string");
    // @ts-expect-error
    expect(() => inc("1.2.3", "prerelease", "beta", "2")).toThrow('`identifierBase` must be "0", "1" or false');
    // @ts-expect-error
    expect(() => inc("1.2.3", "prerelease", "beta", true)).toThrow(TypeError);
    // @ts-expect-error
    expect(inc("1.2.3", "prerelease", "beta", 1)).toBe("1.2.4-beta.1");
    // @ts-expect-error
    expect(inc("1.2.3", "prerelease", "beta", 0)).toBe("1.2.4-beta.0");
    expect(inc("1.2.3", "prerelease", null)).toBe("1.2.4-0");
  });

  test("the result is a version parse() and order() agree on", () => {
    const releases: Release[] = ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"];
    for (const version of ["1.2.3", "0.0.0", "1.2.3-beta.1", "2.0.0-rc.0", "1.0.0-alpha.beta.1+sha"]) {
      for (const release of releases) {
        for (const identifier of [undefined, "zeta"]) {
          const next = inc(version, release, identifier)!;
          expect(parse(next)).not.toBeNull();
          expect([version, release, identifier, order(next, version)]).toEqual([version, release, identifier, 1]);
        }
      }
    }
  });
});

describe("Bun.semver.maxSatisfying() and minSatisfying()", () => {
  // https://github.com/npm/node-semver/blob/main/test/functions/max-satisfying.js and
  // min-satisfying.js, minus the `loose` cases.
  test.each([
    [["1.2.3", "1.2.4"], "1.2", "1.2.4", "1.2.3"],
    [["1.2.4", "1.2.3"], "1.2", "1.2.4", "1.2.3"],
    [["1.2.3", "1.2.4", "1.2.5", "1.2.6"], "~1.2.3", "1.2.6", "1.2.3"],
    [
      ["1.1.0", "1.2.0", "1.2.1", "1.3.0", "2.0.0-b1", "2.0.0-b2", "2.0.0-b3", "2.0.0", "2.1.0"],
      "~2.0.0",
      "2.0.0",
      "2.0.0",
    ],
    [["1.2.3", "1.2.4"], "3.x", null, null],
    [["1.2.3", "1.2.4"], "not a range", null, null],
    [[], "*", null, null],
  ])("%j with %j: max %j, min %j", (versions, range, max, min) => {
    expect(maxSatisfying(versions, range)).toBe(max);
    expect(minSatisfying(versions, range)).toBe(min);
  });

  test("agrees with satisfies() and order()", () => {
    const versions = [
      "0.9.0",
      "1.0.0",
      "1.2.3",
      "v1.2.3",
      "1.2.3+build",
      "1.2.4-alpha.1",
      "1.3.0",
      "2.0.0-rc.1",
      "2.0.0",
      "2.1.0",
      ...unsortedPrereleases.slice(0, 200),
    ];
    const ranges = ["*", "^1.0.0", "~1.2.3", ">=1.0.0-0", "1.x", ">1.2.3-alpha.1 <2", "1.2.3", "1.0.0-alpha.4", "<0"];
    for (const range of ranges) {
      let max: string | null = null;
      let min: string | null = null;
      for (const version of versions) {
        if (!satisfies(version, range)) continue;
        if (max === null || order(version, max) > 0) max = version;
        if (min === null || order(version, min) < 0) min = version;
      }
      expect([range, maxSatisfying(versions, range), minSatisfying(versions, range)]).toEqual([range, max, min]);
    }
  });

  test("prereleases only satisfy a range that opts into their version", () => {
    expect(maxSatisfying(["1.2.3", "1.3.0-beta.1"], "^1.2.0")).toBe("1.2.3");
    expect(maxSatisfying(["1.3.0-beta.1", "1.3.0-beta.2", "1.2.3"], ">=1.3.0-beta.0")).toBe("1.3.0-beta.2");
    expect(minSatisfying(["1.3.0-beta.1", "1.3.0-beta.2", "1.2.3"], ">=1.3.0-beta.0")).toBe("1.3.0-beta.1");
    expect(maxSatisfying(["1.3.0-beta.1"], "^1.2.0")).toBeNull();
  });

  test("skips entries that are not complete versions and keeps the spelling of the winner", () => {
    expect(maxSatisfying(["nope", "1.2.3", "^2.0.0", "1.x", "", "2.0.0.1", "2.0.0 || 3.0.0"], "*")).toBe("1.2.3");
    expect(maxSatisfying([1, null, undefined, {}, "1.0.0"] as any[], "*")).toBe("1.0.0");
    expect(maxSatisfying(["v1.2.3", " 1.2.4 "], "*")).toBe(" 1.2.4 ");
    expect(minSatisfying(["v1.2.3", " 1.2.4 "], "*")).toBe("v1.2.3");
    // A tie goes to the first entry; build metadata does not order.
    expect(maxSatisfying(["1.2.3+a", "1.2.3+b", "v1.2.3"], "*")).toBe("1.2.3+a");
    expect(minSatisfying(["v1.2.3", "1.2.3"], "*")).toBe("v1.2.3");
  });

  test("argument validation", () => {
    // @ts-expect-error
    expect(() => maxSatisfying("1.2.3", "*")).toThrow("`versions` must be an array of strings");
    // @ts-expect-error
    expect(() => minSatisfying(new Set(["1.2.3"]), "*")).toThrow("`versions` must be an array of strings");
    // @ts-expect-error
    expect(() => maxSatisfying()).toThrow(TypeError);
    // The range is stringified like in satisfies().
    expect(maxSatisfying(["1.2.3"], Buffer.from("^1.0.0"))).toBe("1.2.3");
    // @ts-expect-error
    expect(maxSatisfying(["1.2.3"], undefined)).toBeNull();
  });
});

test("a version range with >=256 || comparators does not abort", async () => {
  const range = Array(300).fill("1.0.0").join(" || ");
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", `process.stdout.write(String(Bun.semver.satisfies("1.0.0", ${JSON.stringify(range)})))`],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) expect(stderr).toBe("");
  expect(stdout).toBe("true");
  expect(exitCode).toBe(0);
}, 30_000);

test("a range with a dangling '-' after a skipped tag does not crash the parser", async () => {
  // Found by fuzzing: a "-" that follows a skipped garbage token (or "||") used to
  // reach `unreachable!()` in the range parser once at least one comparator had
  // already been parsed, crashing the process.
  const fuzzed = "> > > > > > > `{" + "`${".repeat(34) + "- - - 1e-323-alpha.1";
  const cases = [
    ["", fuzzed],
    ["1.0.0", fuzzed],
    ["", "1 || -"],
    ["1.0.0", "1 || -"],
    ["2.0.0", "1 || -"],
    ["1.0.0", "1 a - b"],
    // the skipped "-q" chunk must not swallow the "||", so "^2" still matches
    ["2.5.0", "^1 || -q ^2"],
  ];
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(cases)}.map(([version, range]) => Bun.semver.satisfies(version, range))))`,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([true, true, false, true, false, true, true]);
  expect(exitCode).toBe(0);
});

test("a version range made of hundreds of thousands of 'v' or '= ' prefix characters evaluates promptly", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        const n = 1000000;
        const vRun = Buffer.alloc(n, "v").toString();
        const eqRun = Buffer.alloc(n, "= ").toString();
        process.stdout.write(
          JSON.stringify([
            Bun.semver.satisfies("1.0.0", vRun),
            Bun.semver.satisfies("1.0.0", eqRun),
          ]),
        );
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([true, true]);
  expect(exitCode).toBe(0);
}, 30_000);

test("a version range with hundreds of thousands of '||' or AND-ed comparators evaluates without crashing", async () => {
  // Ranges are stored as linked lists: one node per "||" alternative and one
  // node per space-separated AND comparator. Walking a very long chain must be
  // iterative; a recursive traversal overflows the thread stack on a ~750KB
  // range string and the child process dies with SIGSEGV instead of returning
  // an answer. The chains are built inside the spawned script because a string
  // this large cannot be passed as a single argv entry on Linux.
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        const n = 250000;
        const orChain = Array(n).fill("1").join("||");
        const andChain = Array(n).fill(">1").join(" ");
        process.stdout.write(
          JSON.stringify([
            // "2.0.0" matches none of the "1" alternatives, so every OR node is visited
            Bun.semver.satisfies("2.0.0", orChain),
            // a match at the very end of the OR chain is still found
            Bun.semver.satisfies("2.0.0", orChain + "||2"),
            // every AND-ed ">1" comparator matches, so every AND node is visited
            Bun.semver.satisfies("2.0.0", andChain),
            // the first AND comparator fails, so this short-circuits
            Bun.semver.satisfies("1.0.0", andChain),
          ]),
        );
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([false, true, true, false]);
  expect(exitCode).toBe(0);
}, 30_000);
