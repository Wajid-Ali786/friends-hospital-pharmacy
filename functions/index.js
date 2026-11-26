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
