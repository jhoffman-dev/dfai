/** Vite resolves stylesheet imports at build time; TypeScript only needs to know they exist. */
declare module '*.css';

/** Vite hands a file imported with `?inline` over as a `data:` URL. */
declare module '*?inline' {
  const url: string;
  export default url;
}

/** Vite copies a file imported with `?url` into the build and hands over its address. */
declare module '*?url' {
  const url: string;
  export default url;
}
