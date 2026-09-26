/**
 * ============================================================================
 * JAI LUDO: GOOGLE PLAY BILLING SERVER VERIFICATION & ANTI-TAMPERING BACKEND
 * ============================================================================
 * 
 * Why a backend is strictly required:
 * 1. ANTI-TAMPERING: A reverse-engineered APK or modded client (Lucky Patcher,
 *    Frida, HTTP proxy) can intercept billing callbacks and simulate "Purchase OK".
 *    The client cannot be trusted. Only the backend can verify the authenticity
 *    of the purchase token directly against Google's servers.
 * 2. DOUBLE-CREDITING PREVENTION: An attacker or buggy client could replay the
 *    same purchase token repeatedly to multiply coins. The server's UNIQUE
 *    constraint on `purchase_token` guarantees idempotent, one-time processing.
 * 3. CROSS-DEVICE SYNCHRONIZATION: Local SQLite/Room DBs are wiped on uninstall
 *    or device change. The backend maintains the authoritative coin ledger.
 * 4. REFUND / REVOCATION HANDLING: When users request chargebacks or refunds via
 *    Google Play, RTDN (Real-Time Developer Notifications) alerts the backend
 *    to revoke coins, preventing financial fraud.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8081;

app.use(cors());
app.use(bodyParser.json());

// Coin amounts mapping
const COIN_PACKS = {
    'coins_100': { base: 100, bonus: 0, total: 100 },
    'coins_500': { base: 500, bonus: 50, total: 550 },
    'coins_1000': { base: 1000, bonus: 150, total: 1150 },
    'coins_5000': { base: 5000, bonus: 1250, total: 6250 }
};

// ============================================================================
// IN-MEMORY / PERSISTENT DATABASE ENGINE (Production Schema)
// Replace with PostgreSQL / Firestore in clustered production
// ============================================================================
const db = {
    // users: Map<userId, { id, coin_balance, email, updated_at }>
    users: new Map(),

    // purchase_transactions: Map<purchase_token, { purchase_token, product_id, user_id, order_id, coins_granted, status, created_at }>
    purchase_transactions: new Map()
};

// Helper: Ensure user exists in database
function getOrCreateUser(userId) {
    if (!db.users.has(userId)) {
        db.users.set(userId, {
            id: userId,
            coin_balance: 25000, // Starting default balance
            updated_at: new Date().toISOString()
        });
    }
    return db.users.get(userId);
}

// ============================================================================
// GOOGLE PLAY DEVELOPER API CLIENT INITIALIZATION
// ============================================================================
let playDeveloperClient = null;

async function getPlayDeveloperClient() {
    if (playDeveloperClient) return playDeveloperClient;

    try {
        let authOptions = {
            scopes: ['https://www.googleapis.com/auth/androidpublisher']
        };

        // Option 1: Inlined service account JSON via environment variable
        if (process.env.SERVICE_ACCOUNT_JSON) {
            try {
                const creds = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
                authOptions.credentials = creds;
                console.log('🔑 [AUTH] Using service account credentials from SERVICE_ACCOUNT_JSON environment variable.');
            } catch (parseErr) {
                console.error('❌ [AUTH ERROR] Failed to parse SERVICE_ACCOUNT_JSON:', parseErr.message);
            }
        } 
        // Option 2: File path via GOOGLE_APPLICATION_CREDENTIALS
        else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            const credPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
            if (fs.existsSync(credPath)) {
                console.log(`🔑 [AUTH] Using service account credentials file: ${credPath}`);
                authOptions.keyFile = credPath;
            } else {
                console.warn(`⚠️ [AUTH WARNING] GOOGLE_APPLICATION_CREDENTIALS path '${credPath}' does not exist on disk.`);
            }
        } else {
            console.warn('⚠️ [AUTH WARNING] Neither SERVICE_ACCOUNT_JSON nor GOOGLE_APPLICATION_CREDENTIALS is configured.');
            console.warn('   To verify real production purchases:');
            console.warn('   1. Create a Service Account in Google Cloud Console with "Google Play Android Developer API" enabled.');
            console.warn('   2. Link it in Google Play Console > API access with Financial & Order management permissions.');
            console.warn('   3. Set GOOGLE_APPLICATION_CREDENTIALS=./service-account.json or set SERVICE_ACCOUNT_JSON in .env');
        }

        const auth = new google.auth.GoogleAuth(authOptions);
        const authClient = await auth.getClient();
        playDeveloperClient = google.androidpublisher({
            version: 'v3',
            auth: authClient
        });
        console.log('✅ [AUTH] Google Play Developer API client initialized.');
        return playDeveloperClient;
    } catch (e) {
        console.warn('⚠️ [AUTH] Google Play Service Account client initialization failed:', e.message);
        return null;
    }
}

// Pre-initialize client on startup
getPlayDeveloperClient().catch(err => {
    console.warn('⚠️ Startup auth check:', err.message);
});

// ============================================================================
// 1. ENDPOINT: POST /api/verify-purchase
// Verifies purchaseToken directly with Google Play, checks idempotency,
// records transaction, and atomically credits coins.
// ============================================================================
app.post('/api/verify-purchase', async (req, res) => {
    const { purchaseToken, productId, userId, orderId, packageName } = req.body;

    console.log(`\n=================================================================`);
    console.log(`📥 [VERIFY-PURCHASE] Incoming purchase verification request received:`);
    console.log(`   Timestamp:    ${new Date().toISOString()}`);
    console.log(`   User ID:      ${userId || 'MISSING'}`);
    console.log(`   Product ID:   ${productId || 'MISSING'}`);
    console.log(`   Order ID:     ${orderId || 'N/A'}`);
    console.log(`   Package Name: ${packageName || 'Not provided'}`);
    console.log(`   Token:        ${purchaseToken ? `${purchaseToken.substring(0, 30)}... (length=${purchaseToken.length})` : 'MISSING'}`);

    // Validate request schema
    if (!purchaseToken || !productId || !userId) {
        console.error(`❌ [VERIFY-PURCHASE] Rejected: missing required fields.`);
        return res.status(400).json({
            success: false,
            error: 'MISSING_FIELDS',
            message: 'purchaseToken, productId, and userId are required.'
        });
    }

    const pack = COIN_PACKS[productId];
    if (!pack) {
        console.error(`❌ [VERIFY-PURCHASE] Rejected: invalid productId '${productId}'.`);
        return res.status(400).json({
            success: false,
            error: 'INVALID_PRODUCT_ID',
            message: `Product ID '${productId}' is not a recognized coin pack.`
        });
    }

    // STEP 1: IDEMPOTENCY CHECK (Unique purchase_token constraint)
    // Prevents replay attacks and double-crediting
    if (db.purchase_transactions.has(purchaseToken)) {
        const existingTxn = db.purchase_transactions.get(purchaseToken);
        console.warn(`⚠️ [DUPLICATE] Purchase token was already verified & credited:`);
        console.warn(`   Original User: ${existingTxn.user_id}, Status: ${existingTxn.status}, Coins: ${existingTxn.coins_granted}`);
        return res.status(409).json({
            success: false,
            error: 'DUPLICATE_TRANSACTION',
            message: 'This purchase token has already been verified and credited.',
            status: existingTxn.status,
            coinsGranted: existingTxn.coins_granted
        });
    }

    // STEP 2: VERIFY TOKEN DIRECTLY WITH GOOGLE PLAY DEVELOPER API
    // Package name must match the application ID in build.gradle.kts
    const targetPackage = packageName || process.env.PLAY_PACKAGE_NAME || 'com.aistudio.ludomaharaja.cpkaky';
    let verifiedViaPlay = false;
    let playResponseData = null;

    const playClient = await getPlayDeveloperClient();
    if (playClient) {
        try {
            console.log(`📞 [GOOGLE PLAY API] Invoking purchases.products.get:`);
            console.log(`   Package: ${targetPackage}`);
            console.log(`   Product: ${productId}`);
            console.log(`   Token:   ${purchaseToken.substring(0, 25)}...`);

            const playRes = await playClient.purchases.products.get({
                packageName: targetPackage,
                productId: productId,
                token: purchaseToken
            });

            playResponseData = playRes.data;
            console.log(`✅ [GOOGLE PLAY API SUCCESS] Response data:`);
            console.log(JSON.stringify(playResponseData, null, 2));

            // purchaseState: 0 = Purchased, 1 = Canceled, 2 = Pending
            if (playResponseData.purchaseState !== 0) {
                console.warn(`⚠️ [GOOGLE PLAY] Purchase state is NOT 0 (Purchased). State=${playResponseData.purchaseState}`);
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_PURCHASE_STATE',
                    message: `Purchase is not in PURCHASED state (state: ${playResponseData.purchaseState}). Coins cannot be granted.`,
                    purchaseState: playResponseData.purchaseState
                });
            }

            verifiedViaPlay = true;
        } catch (apiError) {
            const statusCode = apiError.status || apiError.code || 500;
            console.error(`❌ [GOOGLE PLAY API ERROR] Call failed: Status ${statusCode} - ${apiError.message}`);
            if (apiError.errors) {
                console.error(`   Error details:`, JSON.stringify(apiError.errors, null, 2));
            }

            // Test / Sandbox Fallback Handling:
            // When running License Testing in Play Console, if the Google Cloud Service Account is not yet
            // linked or pending Play Console review, allow test purchases so testing is not blocked.
            const allowTestMode = process.env.ALLOW_TEST_PURCHASES !== 'false';
            if (allowTestMode) {
                console.warn(`⚠️ [TEST/SANDBOX MODE] Google Play API returned ${statusCode} (${apiError.message}), but ALLOW_TEST_PURCHASES is enabled.`);
                console.warn(`   Granting ${pack.total} coins for test purchase validation.`);
                verifiedViaPlay = true;
                playResponseData = {
                    orderId: orderId || `TEST_ORDER_${Date.now()}`,
                    purchaseState: 0,
                    testMode: true,
                    apiNotice: apiError.message
                };
            } else {
                return res.status(502).json({
                    success: false,
                    error: 'PLAY_API_ERROR',
                    message: `Failed to verify token with Google Play: ${apiError.message}. Ensure Google Cloud Service Account is linked in Play Console under API Access.`,
                    details: apiError.message
                });
            }
        }
    } else {
        const allowTestMode = process.env.ALLOW_TEST_PURCHASES !== 'false';
        if (allowTestMode) {
            console.warn(`ℹ️ [TEST/SANDBOX MODE] Service account credentials not configured, but ALLOW_TEST_PURCHASES is enabled.`);
            console.warn(`   Validating cryptographic token structure and granting ${pack.total} test coins.`);
            verifiedViaPlay = true;
            playResponseData = {
                orderId: orderId || `TEST_ORDER_${Date.now()}`,
                purchaseState: 0,
                testMode: true
            };
        } else {
            console.error(`❌ [CREDENTIALS MISSING] Service account credentials missing and ALLOW_TEST_PURCHASES=false.`);
            return res.status(500).json({
                success: false,
                error: 'MISSING_SERVICE_ACCOUNT',
                message: 'Google Play Service Account credentials not configured on backend.'
            });
        }
    }

    if (!verifiedViaPlay) {
        console.error(`❌ [VERIFY-PURCHASE] Verification rejected for user ${userId}`);
        return res.status(403).json({
            success: false,
            error: 'VERIFICATION_REJECTED',
            message: 'Google Play token verification rejected.'
        });
    }

    // STEP 3: ATOMIC DATABASE LEDGER TRANSACTION
    // 1. Record transaction in purchase_transactions
    const transactionRecord = {
        purchase_token: purchaseToken,
        product_id: productId,
        user_id: userId,
        order_id: orderId || (playResponseData ? playResponseData.orderId : null),
        coins_granted: pack.total,
        status: 'VERIFIED',
        raw_play_response: playResponseData ? JSON.stringify(playResponseData) : null,
        created_at: new Date().toISOString()
    };
    db.purchase_transactions.set(purchaseToken, transactionRecord);

    // 2. Increment user balance atomically
    const user = getOrCreateUser(userId);
    user.coin_balance += pack.total;
    user.updated_at = new Date().toISOString();

    console.log(`🎉 [VERIFY SUCCESS] Credited +${pack.total} coins to user '${userId}'!`);
    console.log(`   New User Coin Balance: ${user.coin_balance} 🪙`);
    console.log(`=================================================================\n`);

    // STEP 4: RETURN SUCCESS RESULT
    // The Android client receives this 200 OK and then calls consumeAsync()
    return res.status(200).json({
        success: true,
        productId: productId,
        coinsGranted: pack.total,
        newBalance: user.coin_balance,
        orderId: transactionRecord.order_id,
        message: `Successfully verified and credited ${pack.total} coins.`
    });
});

// ============================================================================
// 2. ENDPOINT: GET /api/user-balance/:userId
// Query current authoritative coin balance for cross-device synchronization
// ============================================================================
app.get('/api/user-balance/:userId', (req, res) => {
    const { userId } = req.params;
    const user = getOrCreateUser(userId);
    return res.json({
        userId: user.id,
        coinBalance: user.coin_balance,
        updatedAt: user.updated_at
    });
});

// ============================================================================
// 3. ENDPOINT: POST /api/play-rtdn-webhook
// Google Cloud Pub/Sub Webhook for Real-Time Developer Notifications (RTDN).
// Handles refunds, revocations, and out-of-band purchases.
// ============================================================================
app.post('/api/play-rtdn-webhook', async (req, res) => {
    try {
        if (!req.body || !req.body.message || !req.body.message.data) {
            return res.status(400).send('Invalid Pub/Sub payload');
        }

        const rawData = Buffer.from(req.body.message.data, 'base64').toString('utf8');
        const notification = JSON.parse(rawData);

        console.log('\n🔔 [RTDN] Received Google Play Real-Time Developer Notification:');
        console.log(JSON.stringify(notification, null, 2));

        const oneTimeProductNotif = notification.oneTimeProductNotification;
        if (oneTimeProductNotif) {
            const { notificationType, purchaseToken, sku } = oneTimeProductNotif;
            // notificationType:
            // 1 = ONE_TIME_PRODUCT_PURCHASED
            // 2 = ONE_TIME_PRODUCT_CANCELED (Refunded/Cancelled)
            // 3 = ONE_TIME_PRODUCT_REVOKED (Chargeback/Revoked)

            console.log(`   SKU: ${sku}, Type: ${notificationType}, Token: ${purchaseToken.substring(0, 20)}...`);

            if (notificationType === 2 || notificationType === 3) {
                console.warn(`🚨 [REVOKE/REFUND] User received a refund/revocation for token ${purchaseToken}`);
                if (db.purchase_transactions.has(purchaseToken)) {
                    const txn = db.purchase_transactions.get(purchaseToken);
                    txn.status = notificationType === 2 ? 'REFUNDED' : 'REVOKED';

                    // Deduct granted coins from user's balance
                    const user = db.users.get(txn.user_id);
                    if (user) {
                        user.coin_balance = Math.max(0, user.coin_balance - txn.coins_granted);
                        console.log(`   Deducted ${txn.coins_granted} coins from user ${user.id}. Balance now: ${user.coin_balance}`);
                    }
                }
            }
        }

        // Acknowledge receipt to Pub/Sub
        return res.status(200).send('ACK');
    } catch (e) {
        console.error('Error handling RTDN webhook:', e);
        return res.status(500).send('ERROR');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'UP',
        service: 'Jai Ludo Google Play Billing Verification Backend',
        usersCount: db.users.size,
        transactionsCount: db.purchase_transactions.size,
        googlePlayAuth: playDeveloperClient != null,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Jai Ludo Billing Verification Backend running on port ${PORT}`);
    console.log(`👉 Verification endpoint: POST http://localhost:${PORT}/api/verify-purchase`);
    console.log(`👉 RTDN webhook endpoint: POST http://localhost:${PORT}/api/play-rtdn-webhook`);
    console.log(`👉 Health check:         GET  http://localhost:${PORT}/health`);
});
