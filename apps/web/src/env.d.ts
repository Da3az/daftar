/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development only: "1" starts the app on the in-browser mock instead of the API. */
  readonly VITE_USE_MOCK?: string;
}
