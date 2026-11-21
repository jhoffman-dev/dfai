/** The time now. Injected so rules that date things (a conflict copy's name) stay testable. */
export interface Clock {
  now(): Date;
}
