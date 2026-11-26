# vendor/

`firebase-bundle.js` contains Firebase JS SDK **10.14.1** (app, auth, firestore, storage, functions) and **idb 8**
in one file, so the app opens even when gstatic.com / jsdelivr.net cannot be reached (for example offline).
The service worker caches it together with the app.

Rebuild (only needed to upgrade the SDK):

    mkdir build && cd build && npm i firebase@10.14.1 idb@8 esbuild
    # entry.js re-exports exactly the names imported at the top of app.js, e.g.
    #   export { initializeApp } from "firebase/app";
    #   export { getFirestore, doc, ... } from "firebase/firestore";
    #   export { openDB } from "idb";
    npx esbuild entry.js --bundle --format=esm --minify --platform=browser --target=es2020 --legal-comments=none --outfile=../vendor/firebase-bundle.js

Then bump `CACHE_NAME` in `service-worker.js`.
