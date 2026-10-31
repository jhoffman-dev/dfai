/** Vite resolves stylesheet imports at build time; TypeScript only needs to know they exist. */
declare module '*.css';

/** Vite hands a file imported with `?inline` over as a `data:` URL. */
declare module '*?inline' {
  const url: string;
  export default url;
}

/** Where `apps/mcp/dist/main.js` is in the checkout that built this app; see vite.config.ts. */
declare const __ATLAS_MCP_ENTRY__: string | undefined;

/** The short SHA of the commit this app was built from, or null if git could not say; see vite.config.ts. */
declare const __ATLAS_BUILD__: string | null | undefined;

/** Vite copies a file imported with `?url` into the build and hands over its address. */
declare module '*?url' {
  const url: string;
  export default url;
}
