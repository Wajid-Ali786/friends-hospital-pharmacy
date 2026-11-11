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
