/**
 * The route table as the areas compose it (#134): each area of the API lists
 * its own routes (`./contract/<area>.ts`) and answers them
 * (`./handlers/<area>.ts`), and the shared files only put the areas together.
 * These hold the composition to the contract, whatever order it is in.
 */

import { readdirSync } from 'node:fs';
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

/** Every `<area>.ts` in one of the api's folders, by area, with the exports named `*<suffix>`. */
async function areas(folder: string, suffix: string, skip: string) {
  const names = readdirSync(new URL(folder, import.meta.url)).filter(
    (name) => name.endsWith('.ts') && name !== skip,
  );
  return Promise.all(
    names.map(async (name) => {
      const module = (await import(new URL(`${folder}/${name}`, import.meta.url).href)) as Record<
        string,
        unknown
      >;
      const exported = Object.entries(module).filter(([key]) => key.endsWith(suffix));
      return { area: name, exported: exported.map(([, value]) => value) };
    }),
  );
}

describe('every area is composed', () => {
  it('serves every route each contract area lists, and answers every area with a handler table', async () => {
    const served = new Set(API_ROUTES.map(keyOf));
    const contract = await areas('./contract', '_ROUTES', 'wire.ts');
    const unserved = contract.flatMap(({ area, exported }) =>
      (exported as { method: string; path: string }[][])
        .flat()
        .filter((route) => !served.has(keyOf(route)))
        .map((route) => `${area}: ${keyOf(route)}`),
    );
    expect(unserved).toEqual([]);
    expect(contract.filter(({ exported }) => exported.length === 0)).toEqual([]);

    const handlers = await areas('./handlers', '_HANDLERS', 'route-handler.ts');
    expect(handlers.map(({ area }) => area).sort()).toEqual(
      contract.map(({ area }) => area).sort(),
    );
    const unhandled = handlers.flatMap(({ area, exported }) =>
      exported
        .flatMap((table) => Object.keys(table as object))
        .filter((key) => !HANDLED_ROUTES.includes(key))
        .map((key) => `${area}: ${key}`),
    );
    expect(unhandled).toEqual([]);
  });
});

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
