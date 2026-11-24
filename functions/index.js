const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

/**
 * After manually verifying the person over WhatsApp, create:
 * editModeRecovery/{AUTH_UID}
 * {
 *   code: "a-long-random-one-time-code",
 *   expiresAt: Timestamp (within 30 minutes),
 *   createdAt: Timestamp
 * }
 *
 * This document must be inaccessible to client SDKs in Firestore rules.
 * The callable consumes it atomically; the same code cannot be reused.
 */
exports.redeemEditModeRecovery = onCall({ region: "us-central1", maxInstances: 5 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const code = typeof request.data?.code === "string" ? request.data.code.trim() : "";
  if (code.length < 12 || code.length > 128) {
    throw new HttpsError("invalid-argument", "Invalid recovery code.");
  }

  const uid = request.auth.uid;
  const ref = db.collection("editModeRecovery").doc(uid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Recovery code is invalid or expired.");
      const data = snap.data();
      const expiry = data.expiresAt;
      if (typeof data.code !== "string" || data.code !== code ||
          !(expiry instanceof Timestamp) || expiry.toMillis() <= Date.now()) {
        throw new HttpsError("permission-denied", "Recovery code is invalid or expired.");
      }
      tx.delete(ref);
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Edit Mode recovery failed", error);
    throw new HttpsError("internal", "Could not verify recovery code.");
  }
});


/**
 * Wipes pharmacy data for the signed-in UID while keeping the Firebase Auth
 * account intact. A new dataEpoch is written first so other devices can
 * discard stale offline queues before they are allowed to sync again.
 */
exports.wipePharmacyData = onCall({ region: "us-central1", maxInstances: 2, timeoutSeconds: 540 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in again.");
  const authTime = Number(request.auth.token?.auth_time || 0);
  if (!authTime || Date.now() / 1000 - authTime > 300) {
    throw new HttpsError("failed-precondition", "Recent sign-in required. Please sign in again.");
  }

  const uid = request.auth.uid;
  const epoch = require("crypto").randomUUID();
  const accountRef = db.collection("users").doc(uid);

  try {
    // Publish the new epoch before deleting anything. Other devices must
    // compare this value before uploading any queued changes.
    await accountRef.set({ dataEpoch: epoch, dataEpochUpdatedAt: new Date() }, { merge: true });

    await Promise.all([
      db.recursiveDelete(accountRef.collection("medicines")),
      db.recursiveDelete(accountRef.collection("bills")),
      db.collection("editModeRecoveryRequests").doc(uid).delete().catch(() => {}),
      db.collection("editModeRecoveryCooldown").doc(uid).delete().catch(() => {}),
      db.collection("editModeRecoveryApprovals").doc(uid).delete().catch(() => {}),
      db.collection("editModeRecovery").doc(uid).delete().catch(() => {})
    ]);

    // Images are stored below this account-owned prefix.
    await require("firebase-admin/storage").getStorage().bucket().deleteFiles({
      prefix: "users/" + uid + "/"
    });

    return { ok: true, dataEpoch: epoch };
  } catch (error) {
    console.error("Pharmacy data wipe failed for UID", uid, error);
    throw new HttpsError("internal", "Data wipe was incomplete. Do not retry blindly; contact support and check the account data status.");
  }
});
