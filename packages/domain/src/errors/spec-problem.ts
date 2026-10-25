/**
 * One thing wrong with a spec a caller sent — a dashboard's or a view's
 * (P32-05): where in it (`name`, `widgets[2]`), and the checker's own words,
 * unchanged, so a caller is told exactly what the app's editor would say.
 */
export interface SpecProblem {
  readonly at: string;
  readonly message: string;
}
