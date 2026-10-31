/** A SQL file imported as its text (`?raw`), as Vite and Vitest load it: the index schema (#134). */
declare module '*.sql?raw' {
  const text: string;
  export default text;
}
