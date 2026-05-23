CleanSlate Pro Firebase Backend V1

USE THIS VERSION AS THE NEW BASELINE.

What this adds:
- Firebase Google login
- Firestore saved sender history
- Firestore cleanup queue
- Firestore unsubscribe history
- Export / Import backup
- Gmail scan still runs from the web app, but selected senders and history are now permanently saved
- Backend placeholder Cloud Function included for next-stage server processing

IMPORTANT FIREBASE STEPS:
1. Firebase Authentication > Sign-in method > Google > Enable.
2. Firebase Authentication > Settings > Authorized domains:
   Add cleanslateapp.netlify.app
   Add wondrous-taffy-64bd9d.netlify.app if you still use it.
3. Firestore Rules:
   Upload/deploy firestore.rules in this package.
4. GitHub/Netlify:
   Upload these extracted files to your GitHub repo root:
   index.html
   app.js
   config.js
   styles.css
   manifest.json
   firestore.rules
   firebase.json
   functions folder
5. Google OAuth:
   Make sure your Netlify domain is still authorized in Google Cloud OAuth:
   https://cleanslateapp.netlify.app

Current backend note:
The Functions folder is included as a backend-ready placeholder. True server-side Gmail cleanup requires secure OAuth token storage / Google refresh token handling. This package stabilizes persistent app history first so you stop losing information between updates.


NO-FUNCTIONS VERSION NOTE:
This package does NOT require uploading/deploying a functions folder.
Use this version if you are managing everything from phone/GitHub/Netlify.

Upload ONLY these files to GitHub repo root:
- index.html
- app.js
- config.js
- styles.css
- manifest.json
- firestore.rules
- README_SETUP.txt

What works without Functions:
- Firebase Google sign-in
- Firestore saved sender history
- Firestore cleanup queue
- Export/import backup
- Gmail scan
- selected sender history saved permanently
- delete/archive from selected senders through the web app
- unsubscribe history saved

What still cannot be perfect without Functions:
- true server-side webpage automation for every unsubscribe site
- background cleanup while your phone/browser is closed
- secure long-running backend jobs

This is the correct no-PC/no-CLI version.
