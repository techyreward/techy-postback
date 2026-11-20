export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-postback-token"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Techy Rewards Postback Server Active", { status: 200 });
    }

    if (url.pathname !== "/postback") {
      return new Response("Not Found", { status: 404 });
    }

    if (env.POSTBACK_SECRET) {
      const providedToken = (
        url.searchParams.get("token") ||
        request.headers.get("x-postback-token") ||
        ""
      ).trim();
      if (!providedToken || providedToken !== String(env.POSTBACK_SECRET).trim()) {
        return jsonResponse({ success: false, error: "Unauthorized postback token" }, 401);
      }
    }

    const clickId = (
      url.searchParams.get("click_id") ||
      url.searchParams.get("aff_click_id") ||
      url.searchParams.get("sub_aff_id") ||
      url.searchParams.get("sub_id") ||
      url.searchParams.get("subid") ||
      url.searchParams.get("p1") ||
      url.searchParams.get("s1") ||
      url.searchParams.get("s2") ||
      url.searchParams.get("s3") ||
      url.searchParams.get("s4") ||
      url.searchParams.get("s5") ||
      ""
    ).trim();

    const txnId = (
      url.searchParams.get("transaction_id") ||
      url.searchParams.get("txn_id") ||
      ""
    ).trim();

    const eventName = (
      url.searchParams.get("event") ||
      url.searchParams.get("eventname") ||
      "conversion"
    ).trim();

    const networkOfferId = (
      url.searchParams.get("offer_id") ||
      url.searchParams.get("offerid") ||
      ""
    ).trim();

    const rawPayout = Number(url.searchParams.get("payout") || "");
    const convIp = (
      url.searchParams.get("ip") ||
      url.searchParams.get("conversion_ip") ||
      ""
    ).trim();
    const convTime = (
      url.searchParams.get("timestamp") ||
      url.searchParams.get("conversion_time") ||
      ""
    ).trim();

    if (!clickId || clickId.length < 4 || clickId.length > 180) {
      return jsonResponse({ success: false, error: "Invalid or missing click ID" }, 400);
    }

    try {
      const accessToken = await getGoogleAccessToken(env);
      const projectId = env.FIREBASE_PROJECT_ID || "techyrewards-62999";
      const docRoot = `projects/${projectId}/databases/(default)/documents`;
      const baseDocUrl = `https://firestore.googleapis.com/v1/${docRoot}`;

      const clickDoc = await getFirestoreDoc(
        `${baseDocUrl}/offerClicks/${encodeURIComponent(clickId)}`,
        accessToken
      );
      if (!clickDoc) {
        return jsonResponse({ success: false, error: "Click ID not found", clickId }, 404);
      }

      const clickStatus = getStr(clickDoc.fields?.status);
      if (clickStatus === "converted" || clickStatus === "payout_hold") {
        return jsonResponse({
          success: true,
          duplicate: true,
          status: clickStatus,
          message: "Postback already recorded",
          clickId
        }, 200);
      }

      const userId = getStr(clickDoc.fields?.userId).trim();
      const offerId = getStr(clickDoc.fields?.offerId).trim();
      if (!userId || !offerId) {
        return jsonResponse({ success: false, error: "Incomplete click record" }, 400);
      }

      const offerDoc = await getFirestoreDoc(
        `${baseDocUrl}/offers/${encodeURIComponent(offerId)}`,
        accessToken
      );
      if (!offerDoc || offerDoc.fields?.active?.booleanValue === false) {
        return jsonResponse({ success: false, error: "Offer not found or inactive", offerId }, 404);
      }

      if (offerDoc.fields?.postbackEnabled?.booleanValue !== true) {
        return jsonResponse({ success: false, error: "Automatic postback is OFF for this offer", offerId }, 403);
      }

      const userDoc = await getFirestoreDoc(
        `${baseDocUrl}/users/${encodeURIComponent(userId)}`,
        accessToken
      );
      if (!userDoc) {
        return jsonResponse({ success: false, error: "User account not found", userId }, 404);
      }

      if (userDoc.fields?.suspended?.booleanValue === true) {
        return jsonResponse({ success: false, error: "User account is suspended", userId }, 403);
      }

      const userTaskDocId = `${userId}_${offerId}`;
      const existingUserTask = await getFirestoreDoc(
        `${baseDocUrl}/userTasks/${encodeURIComponent(userTaskDocId)}`,
        accessToken
      );
      if (getStr(existingUserTask?.fields?.status).toLowerCase() === "completed") {
        return jsonResponse({ success: true, duplicate: true, message: "Task already completed", clickId }, 200);
      }

      const safeTxnKey = txnId ? `txn_${encodeURIComponent(txnId)}` : "";
      if (safeTxnKey) {
        const existingConv = await getFirestoreDoc(
          `${baseDocUrl}/postbackConversions/${safeTxnKey}`,
          accessToken
        );
        if (existingConv) {
          return jsonResponse({ success: true, duplicate: true, message: "Duplicate transaction ID ignored", txnId }, 200);
        }
      }

      const offerReward = roundMoney(getNum(offerDoc.fields?.reward));
      const networkPayout = Number.isFinite(rawPayout) && rawPayout > 0 ? roundMoney(rawPayout) : 0;
      const reward = offerReward > 0 ? offerReward : (networkPayout > 0 && networkPayout <= 10000 ? networkPayout : 0);

      if (reward <= 0) {
        return jsonResponse({ success: false, error: "Invalid reward amount" }, 400);
      }

      const offerName = getStr(offerDoc.fields?.name) || getStr(clickDoc.fields?.offerName) || "Offer";
      const username =
        getStr(userDoc.fields?.username) ||
        getStr(userDoc.fields?.name) ||
        getStr(userDoc.fields?.firstName) ||
        userId;
      const nowIso = new Date().toISOString();
      const nowLabel = formatIndianNow();
      const queueDocId = `pbq_${encodeURIComponent(clickId)}`;

      const writes = [];

      if (safeTxnKey) {
        writes.push({
          update: {
            name: `${docRoot}/postbackConversions/${safeTxnKey}`,
            fields: {
              txnId: { stringValue: txnId },
              clickId: { stringValue: clickId },
              userId: { stringValue: userId },
              offerId: { stringValue: offerId },
              amount: { doubleValue: reward },
              createdAt: { timestampValue: nowIso }
            }
          },
          currentDocument: { exists: false }
        });
      }

      writes.push({
        update: {
          name: `${docRoot}/offerClicks/${clickId}`,
          fields: {
            ...clickDoc.fields,
            status: { stringValue: "payout_hold" },
            heldAt: { timestampValue: nowIso },
            txnId: { stringValue: txnId },
            eventName: { stringValue: eventName },
            networkOfferId: { stringValue: networkOfferId },
            convIp: { stringValue: convIp },
            convTime: { stringValue: convTime }
          }
        },
        updateMask: {
          fieldPaths: ["status", "heldAt", "txnId", "eventName", "networkOfferId", "convIp", "convTime"]
        }
      });

      writes.push({
        update: {
          name: `${docRoot}/postbackQueue/${queueDocId}`,
          fields: {
            clickId: { stringValue: clickId },
            userId: { stringValue: userId },
            username: { stringValue: username },
            offerId: { stringValue: offerId },
            offerName: { stringValue: offerName },
            reward: { doubleValue: reward },
            txnId: { stringValue: txnId },
            eventName: { stringValue: eventName },
            convIp: { stringValue: convIp },
            status: { stringValue: "pending" },
            date: { stringValue: nowLabel },
            createdAt: { timestampValue: nowIso }
          }
        },
        currentDocument: { exists: false }
      });

      await commitBatch(projectId, accessToken, writes);

      return jsonResponse({
        success: true,
        queued: true,
        status: "pending",
        clickId,
        userId,
        username,
        offerId,
        offerName,
        event: eventName,
        pendingAmount: reward
      }, 200);
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.includes("ALREADY_EXISTS") || msg.includes("409")) {
        return jsonResponse({ success: true, duplicate: true, message: "Duplicate postback ignored", clickId }, 200);
      }
      return jsonResponse({ success: false, error: msg || "Postback processing error" }, 500);
    }
  }
};

function roundMoney(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function getStr(field) {
  if (!field) return "";
  return String(field.stringValue ?? "");
}

function getNum(field) {
  if (!field) return 0;
  const v = field.doubleValue ?? field.integerValue ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatIndianNow() {
  const now = new Date();
  return now.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

async function getFirestoreDoc(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET error (${res.status})`);
  return await res.json();
}

async function commitBatch(projectId, token, writes) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ writes })
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore commit error (${res.status}): ${txt}`);
  }
}

async function getGoogleAccessToken(env) {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKeyPem = (env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKeyPem) {
    throw new Error("Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in Worker secrets");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore"
  }));

  const unsignedToken = `${header}.${claim}`;
  const key = await importPrivateKey(privateKeyPem);
  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken)
  );
  const signature = base64UrlEncodeBytes(new Uint8Array(sigBuffer));
  const jwt = `${unsignedToken}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`OAuth token exchange failed: ${errText}`);
  }

  const tokenJson = await tokenRes.json();
  return tokenJson.access_token;
}

function base64UrlEncode(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlEncodeBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    raw.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
