/**
 * The route table as the areas compose it (#134): each area of the API lists
 * its own routes (`./contract/<area>.ts`) and answers them
 * (`./handlers/<area>.ts`), and the shared files only put the areas together.
 * These hold the composition to the contract, whatever order it is in.
 */

import { describe, expect, it } from 'vitest';
import { API_ROUTES } from './contract.ts';
import { HANDLED_ROUTES, matchRoute } from './routes.ts';

const keyOf = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
const isParam = (segment: string) => /^\{[a-z]+\}$/.test(segment);

/** Whether one request could match both patterns: same method, and every segment open in one or equal. */
function overlap(
  one: { method: string; path: string },
  other: { method: string; path: string },
): boolean {
  if (one.method !== other.method) return false;
  const left = one.path.split('/');
  const right = other.path.split('/');
  return (
    left.length === right.length &&
    left.every((segment, at) => segment === right[at] || isParam(segment) || isParam(right[at]!))
  );
}

describe('the composed route table', () => {
  it('answers exactly the routes the contract lists, each once', () => {
    const listed = API_ROUTES.map(keyOf);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...HANDLED_ROUTES].sort()).toEqual([...listed].sort());
  });

  it('has no two routes one request could match, so the order areas compose in decides nothing', () => {
    const clashes = API_ROUTES.flatMap((route, at) =>
      API_ROUTES.slice(at + 1)
        .filter((other) => overlap(route, other))
        .map((other) => `${keyOf(route)} ~ ${keyOf(other)}`),
    );
    expect(clashes).toEqual([]);
  });

  it('matches each route to itself', () => {
    for (const route of API_ROUTES) {
      const path = route.path.replace(/\{[a-z]+\}/g, 'x');
      expect(matchRoute(route.method, path).route).toBe(keyOf(route));
    }
  });

  it('would see a clash: a literal segment and an open one overlap', () => {
    expect(
      overlap(
        { method: 'GET', path: '/v1/notes/{path}' },
        { method: 'GET', path: '/v1/notes/recent' },
      ),
    ).toBe(true);
    expect(
      overlap(
        { method: 'GET', path: '/v1/notes/{path}' },
        { method: 'POST', path: '/v1/notes/recent' },
      ),
    ).toBe(false);
  });
});
