/** Where the console is served from, as a full address ending in "/": the origin alone, or a sub-path such as
 *  https://host/qhse-cctv/ when a proxy (Nginx) puts it under a location. Nothing in the app may start a URL with "/",
 *  because that would point at the server root instead of this folder. */
const root = () => new URL('./', document.baseURI).href;

const absolute = /^(https?:|data:|blob:|file:)/;

/** A file shipped with the console (public/), or an /api path: "qv/side/home.png", "api/health". A leading "/" is ignored. */
export const assetUrl = (path: string): string => (absolute.test(path) ? path : new URL(path.replace(/^\/+/, ''), root()).href);
