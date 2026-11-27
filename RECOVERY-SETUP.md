# Edit Mode password recovery setup

The app's WhatsApp recovery UI and callable function are committed. The function must be deployed before recovery can work.

## 1. Firebase billing and CLI
Cloud Functions deployment requires the Firebase project to use the Blaze (pay-as-you-go) plan. Enable billing in Firebase Console if it is not already enabled.

On a computer with Node.js installed:
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only functions --project friends-hospital-pharmacy
```
Run these commands from the repository root. The repository includes `.firebaserc`, `firebase.json`, and `functions/package.json`.

## 2. Firestore rules
The app must not be able to read or write recovery grants. Add a deny rule for this collection to the existing Firestore rules:
```
match /editModeRecovery/{uid} {
  allow read, write: if false;
}
```
Important: Firestore rules are additive across matching `match` blocks. Check the existing rules for broader wildcard allows that could still grant access. Do not replace the current rules without reviewing them.

## 3. Issue a code after WhatsApp verification
After you manually verify the person on WhatsApp, create a Firestore document:
- Collection: `editModeRecovery`
- Document ID: that person's Firebase Authentication UID
- Fields:
  - `code` (string): a newly generated random code of at least 12 characters
  - `expiresAt` (timestamp): current time plus 30 minutes
  - `createdAt` (timestamp): current time

Send the code to the verified person on WhatsApp. The app consumes and deletes the grant after successful verification. Only create a grant after checking the registered account identity. Never share Firebase Admin credentials or service-account keys.

## Important
This is a manual recovery flow, not automatic WhatsApp identity verification. Keep the code private and short-lived. The backend has not been deployed by this repository commit.

## Update checklist (Nov 2026 release)

Do these in order after pulling this version:

1. **Firestore rules** – Firebase Console → Firestore Database → Rules → paste the whole `firestore.rules` file → Publish.
   (Adds: 1-hour bill edit/delete limit on the server, medicine validation, shared receipt counter, shared Edit Mode password.)
2. **Functions (skip on the free plan; the app does not call them)** – the runtime is now Node 22 (Node 20 was shut down by Google on 2026-10-30):

       firebase deploy --only functions --project friends-hospital-pharmacy
       firebase functions:delete wipePharmacyData --region us-central1 --project friends-hospital-pharmacy

   (`wipePharmacyData` is no longer used; the "Wash account" button was removed.)
3. **Storage (optional, paid plan only)** – the app runs on the free Spark plan: photos are kept compressed inside Firestore. Only set `USE_FIREBASE_STORAGE=true` in app.js after enabling Storage on a paid plan.
