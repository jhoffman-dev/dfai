// A module that throws as it is evaluated, as a chunk with a broken import does
// (`on-first-use.test.tsx`). Never imported by the app.
function evaluate(): never {
  throw new Error('broken while evaluating');
}

export const Broken: () => null = evaluate();
