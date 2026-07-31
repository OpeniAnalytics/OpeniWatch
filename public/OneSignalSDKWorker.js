/*
 * OneSignal service worker.
 *
 * Must be served from the application origin at the root scope, which is why it
 * lives in `public/` and is copied verbatim into the build output. The Netlify
 * configuration adds `Service-Worker-Allowed: /` so the root scope is granted.
 *
 * It is registered only after an operator explicitly opts in to web push; see
 * src/services/notifications/pushRegistration.ts.
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')
